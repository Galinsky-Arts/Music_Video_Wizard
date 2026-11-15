import {
  DependencyRelation,
  DomainVersionKind,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { songPicturePlanDocumentSchema } from "@/lib/song-picture-plan/schema";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import {
  sequenceMapCompletionIssues,
  sequenceMapEditSchema,
  sequenceSourceSpecSchema,
  sequenceSpecFromPassage,
  type SequenceMapEdit
} from "./schema";

export class SequenceMapError extends Error {}
export class SequenceMapConflictError extends SequenceMapError {}

type Tx = Prisma.TransactionClient;

function toJson(value:unknown):Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function latestLockedPlan(tx:Tx, projectId:string) {
  return tx.songPicturePlanVersion.findFirst({
    where:{
      lifecycle:VersionLifecycle.LOCKED,
      songPicturePlan:{projectId}
    },
    orderBy:{versionNumber:"desc"},
    include:{songPicturePlan:true}
  });
}

function mapFingerprint(input:{
  sourceSongPicturePlanVersionId:string;
  sequences:Array<{
    sequenceVersionId:string;
    nodeId:string;
    title:string;
    summary:string|null;
    purpose:string|null;
    startMs:number|null;
    endMs:number|null;
    targetShotCount:number|null;
    planningNotes:string;
  }>;
}) {
  return fingerprintJson(toJson(input) as unknown as Prisma.JsonValue);
}

async function serializeSequenceMap(tx:Tx, projectVersionId:string) {
  const links=await tx.projectVersionSequence.findMany({
    where:{projectVersionId},
    orderBy:{position:"asc"},
    include:{sequenceVersion:{include:{sequence:true}}}
  });

  const sequences=links.map(link=>{
    const version=link.sequenceVersion;
    const spec=sequenceSourceSpecSchema.parse(version.structuredSpec);
    return {
      position:link.position,
      sequenceId:version.sequenceId,
      sequenceVersionId:version.id,
      nodeId:version.nodeId,
      versionNumber:version.versionNumber,
      lifecycle:version.lifecycle,
      title:version.title,
      summary:version.summary,
      purpose:version.purpose,
      startMs:version.musicStartMs,
      endMs:version.musicEndMs,
      sourcePassageIndex:spec.sourcePassageIndex,
      sourcePassageTitle:spec.sourcePassageTitle,
      sourceSongPicturePlanVersionId:spec.sourceSongPicturePlanVersionId,
      sourceSongPicturePlanNodeId:spec.sourceSongPicturePlanNodeId,
      targetShotCount:spec.targetShotCount,
      planningNotes:spec.planningNotes,
      sourceContext:{
        dramaticPurpose:spec.dramaticPurpose,
        pictureState:spec.pictureState,
        narrativeState:spec.narrativeState,
        characterState:spec.characterState,
        performanceMode:spec.performanceMode,
        worldState:spec.worldState,
        motifState:spec.motifState,
        creativeLanguageApplication:spec.creativeLanguageApplication,
        cameraAndMotionIntent:spec.cameraAndMotionIntent,
        editingRhythm:spec.editingRhythm,
        transitionIn:spec.transitionIn,
        transitionOut:spec.transitionOut,
        visualIntensity:spec.visualIntensity
      }
    };
  });

  const sourceSongPicturePlanVersionId=
    sequences[0]?.sourceSongPicturePlanVersionId ?? null;
  const sourceSongPicturePlanNodeId=
    sequences[0]?.sourceSongPicturePlanNodeId ?? null;

  return {
    sourceSongPicturePlanVersionId,
    sourceSongPicturePlanNodeId,
    sequences
  };
}

async function wizardPayload(tx:Tx, projectVersionId:string) {
  const map=await serializeSequenceMap(tx,projectVersionId);
  return toJson({
    sourceSongPicturePlanVersionId:map.sourceSongPicturePlanVersionId,
    sourceSongPicturePlanNodeId:map.sourceSongPicturePlanNodeId,
    sequenceCount:map.sequences.length,
    sequenceVersionIds:map.sequences.map(s=>s.sequenceVersionId),
    sequenceNodeIds:map.sequences.map(s=>s.nodeId)
  });
}

async function refreshSequenceNode(
  tx:Tx,
  sequenceVersionId:string
) {
  const version=await tx.sequenceVersion.findUniqueOrThrow({
    where:{id:sequenceVersionId}
  });
  const spec=sequenceSourceSpecSchema.parse(version.structuredSpec);
  const fingerprint=fingerprintJson(toJson({
    title:version.title,
    summary:version.summary,
    purpose:version.purpose,
    musicStartMs:version.musicStartMs,
    musicEndMs:version.musicEndMs,
    structuredSpec:spec
  }) as unknown as Prisma.JsonValue);
  await tx.domainVersionNode.update({
    where:{id:version.nodeId},
    data:{fingerprint}
  });
  return fingerprint;
}

async function refreshMapFingerprint(tx:Tx, projectVersionId:string) {
  const map=await serializeSequenceMap(tx,projectVersionId);
  for(const sequence of map.sequences){
    await refreshSequenceNode(tx,sequence.sequenceVersionId);
  }
  const fingerprint=mapFingerprint({
    sourceSongPicturePlanVersionId:
      map.sourceSongPicturePlanVersionId ?? "00000000-0000-4000-8000-000000000000",
    sequences:map.sequences.map(s=>({
      sequenceVersionId:s.sequenceVersionId,
      nodeId:s.nodeId,
      title:s.title,
      summary:s.summary,
      purpose:s.purpose,
      startMs:s.startMs,
      endMs:s.endMs,
      targetShotCount:s.targetShotCount,
      planningNotes:s.planningNotes
    }))
  });
  return {map,fingerprint};
}

async function syncWizard(tx:Tx, projectVersionId:string) {
  const refreshed=await refreshMapFingerprint(tx,projectVersionId);
  const wizard=await saveManagedWizardStepInTransaction(tx,{
    projectVersionId,
    stepKey:"sequence-map",
    payload:await wizardPayload(tx,projectVersionId),
    semanticFingerprint:refreshed.fingerprint
  });
  return {...refreshed,wizard};
}

async function mutationContext(tx:Tx,input:{
  userId:string;
  projectId:string;
  projectVersionId:string;
  expectedWizardRevision:number;
}) {
  const progress=await tx.wizardProgress.findFirst({
    where:{
      projectVersionId:input.projectVersionId,
      projectVersion:{
        projectId:input.projectId,
        project:{workspace:{memberships:{some:{userId:input.userId}}}}
      }
    },
    include:{projectVersion:true,steps:true}
  });
  if(!progress) throw new SequenceMapError("Sequence Map wizard state not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new SequenceMapConflictError(
      "Sequence Map changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(s=>s.stepKey==="sequence-map");
  if(!step) throw new SequenceMapError("Sequence Map wizard step is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("The Sequence Map is locked.");
  return {progress,step};
}

export async function initializeSequenceMap(input:{
  userId:string;
  projectId:string;
}) {
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const plan=await latestLockedPlan(tx,input.projectId);
    if(!plan){
      throw new SequenceMapError(
        "Lock the Song-to-Picture Plan before materializing sequences."
      );
    }
    const document=songPicturePlanDocumentSchema.parse(plan.document);
    const existing=await tx.projectVersionSequence.findMany({
      where:{projectVersionId:projectVersion.id},
      orderBy:{position:"asc"},
      include:{sequenceVersion:true}
    });

    const alreadyCurrent=
      existing.length===document.passages.length &&
      existing.every((link,index)=>{
        try{
          const spec=sequenceSourceSpecSchema.parse(
            link.sequenceVersion.structuredSpec
          );
          return (
            spec.sourceSongPicturePlanVersionId===plan.id &&
            spec.sourcePassageIndex===index
          );
        }catch{return false;}
      });

    if(alreadyCurrent){
      return {
        ...(await serializeSequenceMap(tx,projectVersion.id)),
        impactWarnings:[]
      };
    }

    const priorByPosition=new Map(existing.map(link=>[
      link.position,
      link.sequenceVersion
    ]));

    const created:Array<{
      position:number;
      sequenceVersionId:string;
    }>=[];
    for(let index=0;index<document.passages.length;index++){
      const passage=document.passages[index]!;
      const prior=priorByPosition.get(index);
      let sequenceId=prior?.sequenceId;

      if(!sequenceId){
        const logical=await tx.sequence.create({
          data:{projectId:input.projectId}
        });
        sequenceId=logical.id;
      }

      if(prior?.lifecycle===VersionLifecycle.DRAFT){
        await tx.sequenceVersion.update({
          where:{id:prior.id},
          data:{lifecycle:VersionLifecycle.SUPERSEDED}
        });
      }

      const latest=await tx.sequenceVersion.findFirst({
        where:{sequenceId},
        orderBy:{versionNumber:"desc"},
        select:{versionNumber:true}
      });
      const node=await tx.domainVersionNode.create({
        data:{kind:DomainVersionKind.SEQUENCE}
      });
      const spec=sequenceSpecFromPassage({
        sourceSongPicturePlanVersionId:plan.id,
        sourceSongPicturePlanNodeId:plan.nodeId,
        passageIndex:index,
        passage
      });
      const version=await tx.sequenceVersion.create({
        data:{
          sequenceId,
          nodeId:node.id,
          versionNumber:(latest?.versionNumber??0)+1,
          title:passage.title,
          summary:passage.pictureState,
          purpose:passage.dramaticPurpose,
          musicStartMs:passage.startMs,
          musicEndMs:passage.endMs,
          structuredSpec:toJson(spec),
          createdByUserId:input.userId
        }
      });
      await registerDependencyEdgeInTransaction(tx,{
        upstreamNodeId:plan.nodeId,
        downstreamNodeId:node.id,
        relation:DependencyRelation.REFERENCES,
        reason:"Sequence Map materializes this exact locked Song-to-Picture passage."
      });
      created.push({position:index,sequenceVersionId:version.id});
    }

    await tx.projectVersionSequence.deleteMany({
      where:{projectVersionId:projectVersion.id}
    });
    await tx.projectVersionSequence.createMany({
      data:created.map(item=>({
        projectVersionId:projectVersion.id,
        sequenceVersionId:item.sequenceVersionId,
        position:item.position
      }))
    });

    const synced=await syncWizard(tx,projectVersion.id);
    return {
      ...synced.map,
      impactWarnings:synced.wizard.impactWarnings
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function saveSequenceMap(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  sequences:SequenceMapEdit[];
}) {
  const projectVersion=await ensureWizardProgress(input);
  const edits=input.sequences.map(value=>sequenceMapEditSchema.parse(value));

  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const links=await tx.projectVersionSequence.findMany({
      where:{projectVersionId:projectVersion.id},
      include:{sequenceVersion:true}
    });
    const byId=new Map(links.map(link=>[
      link.sequenceVersionId,
      link.sequenceVersion
    ]));
    if(edits.length!==links.length){
      throw new SequenceMapError(
        "Save must include every active sequence in the map."
      );
    }

    for(const edit of edits){
      const current=byId.get(edit.sequenceVersionId);
      if(!current) throw new SequenceMapError("Sequence version is not active in this map.");
      if(current.lifecycle!==VersionLifecycle.DRAFT){
        throw new WizardLockedError("Only draft sequence versions can be edited.");
      }
      const spec=sequenceSourceSpecSchema.parse(current.structuredSpec);
      await tx.sequenceVersion.update({
        where:{id:current.id},
        data:{
          title:edit.title,
          summary:edit.summary||null,
          purpose:edit.purpose,
          musicStartMs:edit.startMs,
          musicEndMs:edit.endMs,
          structuredSpec:toJson({
            ...spec,
            targetShotCount:edit.targetShotCount,
            planningNotes:edit.planningNotes
          })
        }
      });
    }

    const synced=await syncWizard(tx,projectVersion.id);
    return {
      ...synced.map,
      impactWarnings:synced.wizard.impactWarnings
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function completeSequenceMap(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}) {
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const map=await serializeSequenceMap(tx,projectVersion.id);
    if(!map.sourceSongPicturePlanVersionId){
      throw new SequenceMapError("Materialize the Sequence Map first.");
    }
    const plan=await tx.songPicturePlanVersion.findUniqueOrThrow({
      where:{id:map.sourceSongPicturePlanVersionId}
    });
    const document=songPicturePlanDocumentSchema.parse(plan.document);
    const durationMs=document.passages.at(-1)?.endMs??0;
    const edits=map.sequences.map(s=>sequenceMapEditSchema.parse({
      sequenceVersionId:s.sequenceVersionId,
      title:s.title,
      summary:s.summary??"",
      purpose:s.purpose??"",
      startMs:s.startMs??0,
      endMs:s.endMs??0,
      targetShotCount:s.targetShotCount,
      planningNotes:s.planningNotes
    }));
    const issues=sequenceMapCompletionIssues(edits,durationMs);
    if(issues.length) throw new SequenceMapError(issues.join(" "));

    const refreshed=await refreshMapFingerprint(tx,projectVersion.id);
    const wizard=await completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:projectVersion.id,
      stepKey:"sequence-map",
      payload:await wizardPayload(tx,projectVersion.id),
      semanticFingerprint:refreshed.fingerprint
    });
    return {
      ...refreshed.map,
      impactWarnings:wizard.impactWarnings
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function reopenSequenceMap(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}) {
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(context.step.status!==WizardStepStatus.COMPLETED){
      return {...(await serializeSequenceMap(tx,projectVersion.id)),impactWarnings:[]};
    }
    await tx.wizardStepState.update({
      where:{id:context.step.id},
      data:{
        status:WizardStepStatus.IN_PROGRESS,
        completedAt:null,
        needsReviewAt:null,
        reviewReason:null
      }
    });
    await tx.wizardProgress.update({
      where:{id:context.progress.id},
      data:{revision:{increment:1},currentStepKey:"sequence-map"}
    });
    return {...(await serializeSequenceMap(tx,projectVersion.id)),impactWarnings:[]};
  });
}

export async function lockSequenceMap(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}) {
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(context.step.status!==WizardStepStatus.COMPLETED){
      throw new SequenceMapError("Complete the Sequence Map before locking it.");
    }
    const links=await tx.projectVersionSequence.findMany({
      where:{projectVersionId:projectVersion.id},
      select:{sequenceVersionId:true}
    });
    if(links.length===0) throw new SequenceMapError("Sequence Map is empty.");
    const now=new Date();
    await tx.sequenceVersion.updateMany({
      where:{
        id:{in:links.map(link=>link.sequenceVersionId)},
        lifecycle:VersionLifecycle.DRAFT
      },
      data:{lifecycle:VersionLifecycle.LOCKED,lockedAt:now}
    });
    await tx.wizardStepState.update({
      where:{id:context.step.id},
      data:{lockedAt:now}
    });
    await tx.wizardProgress.update({
      where:{id:context.progress.id},
      data:{revision:{increment:1}}
    });
    for(const link of links){
      await refreshSequenceNode(tx,link.sequenceVersionId);
    }
    return {...(await serializeSequenceMap(tx,projectVersion.id)),impactWarnings:[]};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getSequenceMapState(input:{
  userId:string;
  projectId:string;
}) {
  const projectVersion=await ensureWizardProgress(input);
  const project=await db.project.findFirst({
    where:{
      id:input.projectId,
      workspace:{memberships:{some:{userId:input.userId}}}
    },
    include:{
      songPicturePlan:{
        include:{
          versions:{
            where:{lifecycle:VersionLifecycle.LOCKED},
            orderBy:{versionNumber:"desc"},
            take:1
          }
        }
      }
    }
  });
  if(!project) throw new SequenceMapError("Project not found.");

  const source=project.songPicturePlan?.versions[0]??null;
  const map=await serializeSequenceMap(db,projectVersion.id);
  const step=projectVersion.wizardProgress?.steps.find(
    candidate=>candidate.stepKey==="sequence-map"
  );

  return {
    sourceReady:Boolean(source),
    latestSongPicturePlanVersionNumber:source?.versionNumber??null,
    needsRebase:Boolean(
      source &&
      map.sourceSongPicturePlanVersionId &&
      map.sourceSongPicturePlanVersionId!==source.id
    ),
    map,
    wizardRevision:projectVersion.wizardProgress?.revision??0,
    wizardStatus:step?.status??WizardStepStatus.NOT_STARTED,
    wizardLocked:Boolean(step?.lockedAt)
  };
}
