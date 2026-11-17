import {
  DependencyRelation,
  DomainVersionKind,
  GenerationKind,
  GenerationStatus,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { getEnvironment } from "@/lib/env";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import { sequenceSourceSpecSchema } from "@/lib/sequence-map/schema";
import {
  getConfiguredTextProvider,
  textGenerationAvailable
} from "@/lib/text-generation/factory";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import {
  queuedStoryboardGenerationSchema,
  queuedStoryboardShotRegenerationSchema,
  storyboardRewriteFieldsSchema
} from "./input";
import {
  storyboardCompletionIssues,
  storyboardDocumentSchema,
  storyboardShotSchema,
  storyboardShotSpecSchema,
  type StoryboardDocument
} from "./schema";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class StoryboardError extends Error {}
export class StoryboardConflictError extends StoryboardError {}

type Tx=Prisma.TransactionClient;

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function activeSequences(tx:Tx,projectVersionId:string){
  const links=await tx.projectVersionSequence.findMany({
    where:{projectVersionId},
    orderBy:{position:"asc"},
    include:{sequenceVersion:true}
  });
  return links.map(link=>({
    position:link.position,
    version:link.sequenceVersion,
    spec:sequenceSourceSpecSchema.parse(link.sequenceVersion.structuredSpec)
  }));
}

async function activeStoryboardJob(tx:Tx,projectId:string){
  return tx.generationJob.findFirst({
    where:{
      projectId,
      kind:GenerationKind.TEXT,
      providerKey:{contains:":storyboard"},
      status:{in:[GenerationStatus.QUEUED,GenerationStatus.RUNNING]}
    },
    orderBy:{createdAt:"desc"}
  });
}

async function mutationContext(tx:Tx,input:{
  userId:string;
  projectId:string;
  projectVersionId:string;
  expectedWizardRevision:number;
}){
  const progress=await tx.wizardProgress.findFirst({
    where:{
      projectVersionId:input.projectVersionId,
      projectVersion:{
        projectId:input.projectId,
        project:{...projectEditorWhere(input.userId)}
      }
    },
    include:{projectVersion:true,steps:true}
  });
  if(!progress) throw new StoryboardError("Storyboard wizard state not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new StoryboardConflictError(
      "Storyboard changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(item=>item.stepKey==="storyboard");
  if(!step) throw new StoryboardError("Storyboard wizard step is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("The Storyboard is locked.");
  const sequenceStep=progress.steps.find(item=>item.stepKey==="sequence-map");
  if(!sequenceStep?.lockedAt){
    throw new StoryboardError(
      "Lock the Sequence Map before generating the storyboard."
    );
  }
  return {progress,step};
}

async function serializeStoryboard(tx:Tx,projectVersionId:string){
  const links=await tx.projectVersionSequence.findMany({
    where:{projectVersionId},
    orderBy:{position:"asc"},
    include:{
      sequenceVersion:{
        include:{
          shotLinks:{
            orderBy:{position:"asc"},
            include:{shotVersion:true}
          }
        }
      }
    }
  });
  return {
    sequences:links.map(link=>{
      const sequence=link.sequenceVersion;
      const sequenceSpec=sequenceSourceSpecSchema.parse(sequence.structuredSpec);
      return {
        position:link.position,
        sequenceVersionId:sequence.id,
        sequenceNodeId:sequence.nodeId,
        sequenceVersionNumber:sequence.versionNumber,
        sequenceLifecycle:sequence.lifecycle,
        title:sequence.title,
        startMs:sequence.musicStartMs,
        endMs:sequence.musicEndMs,
        targetShotCount:sequenceSpec.targetShotCount,
        shots:sequence.shotLinks.map(shotLink=>{
          const shot=shotLink.shotVersion;
          const spec=storyboardShotSpecSchema.parse(shot.structuredSpec);
          return {
            position:shotLink.position,
            shotId:shot.shotId,
            shotVersionId:shot.id,
            nodeId:shot.nodeId,
            versionNumber:shot.versionNumber,
            lifecycle:shot.lifecycle,
            label:shot.label,
            startMs:shot.plannedStartMs,
            endMs:shot.plannedEndMs,
            dramaticPurpose:shot.dramaticPurpose,
            subject:shot.subject,
            action:shot.action,
            environment:shot.locationDescription,
            framingIntent:shot.composition,
            cameraIntent:shot.cameraMotion,
            continuityNotes:shot.continuityNotes,
            transitionIn:shot.transitionIn,
            transitionOut:shot.transitionOut,
            visualIntensity:spec.visualIntensity,
            beat:spec.beat,
            origin:spec.origin,
            generationJobId:spec.generationJobId
          };
        })
      };
    })
  };
}

function storyboardFingerprint(state:Awaited<ReturnType<typeof serializeStoryboard>>){
  return fingerprintJson(toJson(state) as unknown as Prisma.JsonValue);
}

async function storyboardPayload(tx:Tx,projectVersionId:string){
  const state=await serializeStoryboard(tx,projectVersionId);
  return toJson({
    sequenceVersionIds:state.sequences.map(sequence=>sequence.sequenceVersionId),
    shotVersionIds:state.sequences.flatMap(sequence=>
      sequence.shots.map(shot=>shot.shotVersionId)
    ),
    shotNodeIds:state.sequences.flatMap(sequence=>
      sequence.shots.map(shot=>shot.nodeId)
    ),
    shotCount:state.sequences.reduce(
      (sum,sequence)=>sum+sequence.shots.length,
      0
    )
  });
}

export async function queueStoryboardGeneration(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  direction:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  const configured=getConfiguredTextProvider(getEnvironment());

  const context=await db.$transaction(async tx=>{
    const current=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(await activeStoryboardJob(tx,input.projectId)){
      throw new StoryboardError("A storyboard generation job is already active.");
    }
    const sequences=await activeSequences(tx,projectVersion.id);
    if(sequences.length===0){
      throw new StoryboardError("The locked Sequence Map is empty.");
    }
    if(sequences.some(item=>item.version.lifecycle!==VersionLifecycle.LOCKED)){
      throw new StoryboardError(
        "Every active Sequence Map sequence must be locked."
      );
    }
    return {
      progressId:current.progress.id,
      stepId:current.step.id,
      sequences
    };
  });

  const request=queuedStoryboardGenerationSchema.parse({
    textOperation:"storyboard",
    projectId:input.projectId,
    projectVersionId:projectVersion.id,
    sequenceVersionIds:context.sequences.map(item=>item.version.id),
    direction:input.direction
  });
  const workspace=await db.project.findUniqueOrThrow({
    where:{id:input.projectId},
    select:{workspaceId:true}
  });

  const job=await enqueueGenerationJob({
    workspaceId:workspace.workspaceId,
    projectId:input.projectId,
    kind:GenerationKind.TEXT,
    providerKey:configured.provider.key+":storyboard",
    modelKey:configured.model,
    requestSnapshot:toJson(request),
    requestedByUserId:input.userId,
    inputs:context.sequences.map(item=>({
      nodeId:item.version.nodeId,
      role:"storyboard-sequence",
      position:item.position
    })),
    prepare:async(tx)=>{
      await tx.wizardStepState.update({
        where:{id:context.stepId},
        data:{
          status:WizardStepStatus.IN_PROGRESS,
          completedAt:null,
          needsReviewAt:null,
          reviewReason:null
        }
      });
      await tx.wizardProgress.update({
        where:{id:context.progressId},
        data:{revision:{increment:1},currentStepKey:"storyboard"}
      });
    }
  });
  return {jobId:job.id,status:job.status};
}

export async function persistStoryboardGeneration(input:{
  generationJobId:string;
  projectId:string;
  projectVersionId:string;
  sequenceVersionIds:string[];
  storyboard:StoryboardDocument;
}){
  const storyboard=storyboardDocumentSchema.parse(input.storyboard);
  return db.$transaction(async tx=>{
    const job=await tx.generationJob.findUniqueOrThrow({
      where:{id:input.generationJobId}
    });
    const request=queuedStoryboardGenerationSchema.parse(job.requestSnapshot);
    if(
      request.projectId!==input.projectId ||
      request.projectVersionId!==input.projectVersionId ||
      request.sequenceVersionIds.length!==input.sequenceVersionIds.length ||
      request.sequenceVersionIds.some((id,index)=>id!==input.sequenceVersionIds[index])
    ){
      throw new StoryboardError("Storyboard generation no longer matches its queued source.");
    }

    const sequences=await activeSequences(tx,input.projectVersionId);
    const activeIds=sequences.map(item=>item.version.id);
    if(
      activeIds.length!==input.sequenceVersionIds.length ||
      activeIds.some((id,index)=>id!==input.sequenceVersionIds[index]) ||
      sequences.some(item=>item.version.lifecycle!==VersionLifecycle.LOCKED)
    ){
      throw new StoryboardError("Sequence Map changed after storyboard generation was queued.");
    }

    const constraints=sequences.map(item=>({
      sequenceVersionId:item.version.id,
      startMs:item.version.musicStartMs??0,
      endMs:item.version.musicEndMs??0,
      targetShotCount:item.spec.targetShotCount
    }));
    const issues=storyboardCompletionIssues(storyboard,constraints);
    if(issues.length) throw new StoryboardError(issues.join(" "));

    const existingOutput=await tx.generationOutput.findFirst({
      where:{jobId:input.generationJobId,role:"storyboard-shot"}
    });
    if(existingOutput){
      return {projectVersionId:input.projectVersionId};
    }

    let globalPosition=0;
    for(const sequenceResult of storyboard.sequences){
      const sequence=sequences.find(
        item=>item.version.id===sequenceResult.sequenceVersionId
      )!;
      const priorLinks=await tx.sequenceVersionShot.findMany({
        where:{sequenceVersionId:sequence.version.id},
        orderBy:{position:"asc"},
        include:{shotVersion:true}
      });
      const priorByPosition=new Map(priorLinks.map(link=>[
        link.position,
        link.shotVersion
      ]));
      await tx.shotVersion.updateMany({
        where:{
          id:{in:priorLinks.map(link=>link.shotVersionId)},
          lifecycle:VersionLifecycle.DRAFT
        },
        data:{lifecycle:VersionLifecycle.SUPERSEDED}
      });

      await tx.sequenceVersionShot.deleteMany({
        where:{sequenceVersionId:sequence.version.id}
      });

      for(let position=0;position<sequenceResult.shots.length;position++){
        const generated=sequenceResult.shots[position]!;
        const prior=priorByPosition.get(position);
        let shotId=prior?.shotId;
        if(!shotId){
          const logical=await tx.shot.create({
            data:{projectId:input.projectId}
          });
          shotId=logical.id;
        }
        const latest=await tx.shotVersion.findFirst({
          where:{shotId},
          orderBy:{versionNumber:"desc"},
          select:{versionNumber:true}
        });
        const node=await tx.domainVersionNode.create({
          data:{kind:DomainVersionKind.SHOT}
        });
        const spec=storyboardShotSpecSchema.parse({
          schemaVersion:1,
          stage:"STORYBOARD",
          sourceSequenceVersionId:sequence.version.id,
          sourceSequenceNodeId:sequence.version.nodeId,
          sourceSequencePosition:sequence.position,
          sourceShotPosition:position,
          beat:generated.beat,
          environment:generated.environment,
          framingIntent:generated.framingIntent,
          cameraIntent:generated.cameraIntent,
          visualIntensity:generated.visualIntensity,
          generationJobId:input.generationJobId
        });
        const version=await tx.shotVersion.create({
          data:{
            shotId,
            nodeId:node.id,
            versionNumber:(latest?.versionNumber??0)+1,
            label:generated.label,
            plannedStartMs:generated.startMs,
            plannedEndMs:generated.endMs,
            dramaticPurpose:generated.dramaticPurpose,
            subject:generated.subject,
            locationDescription:generated.environment,
            action:generated.action,
            composition:generated.framingIntent,
            cameraMotion:generated.cameraIntent,
            continuityNotes:generated.continuityNotes,
            transitionIn:generated.transitionIn,
            transitionOut:generated.transitionOut,
            structuredSpec:toJson(spec),
            createdByUserId:job.requestedByUserId
          }
        });
        const fingerprint=fingerprintJson(toJson({
          label:version.label,
          startMs:version.plannedStartMs,
          endMs:version.plannedEndMs,
          dramaticPurpose:version.dramaticPurpose,
          subject:version.subject,
          action:version.action,
          structuredSpec:spec
        }) as unknown as Prisma.JsonValue);
        await tx.domainVersionNode.update({
          where:{id:node.id},
          data:{fingerprint}
        });
        await registerDependencyEdgeInTransaction(tx,{
          upstreamNodeId:sequence.version.nodeId,
          downstreamNodeId:node.id,
          relation:DependencyRelation.REFERENCES,
          reason:"Storyboard shot is derived from this exact locked SequenceVersion."
        });
        await tx.sequenceVersionShot.create({
          data:{
            sequenceVersionId:sequence.version.id,
            shotVersionId:version.id,
            position
          }
        });
        await tx.generationOutput.create({
          data:{
            jobId:input.generationJobId,
            nodeId:node.id,
            role:"storyboard-shot",
            position:globalPosition++
          }
        });
      }
    }

    const state=await serializeStoryboard(tx,input.projectVersionId);
    await completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:input.projectVersionId,
      stepKey:"storyboard",
      payload:await storyboardPayload(tx,input.projectVersionId),
      semanticFingerprint:storyboardFingerprint(state)
    });
    return {
      projectVersionId:input.projectVersionId,
      shotCount:state.sequences.reduce(
        (sum,sequence)=>sum+sequence.shots.length,
        0
      )
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getStoryboardState(input:{
  userId:string;
  projectId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  const progress=projectVersion.wizardProgress!;
  const sequenceStep=progress.steps.find(step=>step.stepKey==="sequence-map");
  const storyboardStep=progress.steps.find(step=>step.stepKey==="storyboard");
  const sequences=await activeSequences(db,projectVersion.id);
  const state=await serializeStoryboard(db,projectVersion.id);
  const recentJob=await db.generationJob.findFirst({
    where:{
      projectId:input.projectId,
      kind:GenerationKind.TEXT,
      providerKey:{contains:":storyboard"}
    },
    orderBy:{createdAt:"desc"},
    select:{
      id:true,
      status:true,
      progressPercent:true,
      progressMessage:true,
      errorMessage:true
    }
  });
  let providerAvailable=false;
  try{providerAvailable=textGenerationAvailable(getEnvironment());}catch{}

  const sourceReady=Boolean(
    sequenceStep?.lockedAt &&
    sequences.length>0 &&
    sequences.every(item=>item.version.lifecycle===VersionLifecycle.LOCKED)
  );
  const activeIds=new Set(sequences.map(item=>item.version.id));
  const storyboardSourceIds=new Set(
    state.sequences
      .filter(sequence=>sequence.shots.length>0)
      .map(sequence=>sequence.sequenceVersionId)
  );

  return {
    sourceReady,
    providerAvailable,
    recentJob,
    storyboard:state,
    needsRegeneration:Boolean(
      sourceReady &&
      (
        storyboardSourceIds.size!==activeIds.size ||
        [...activeIds].some(id=>!storyboardSourceIds.has(id))
      )
    ),
    wizardRevision:progress.revision,
    wizardStatus:storyboardStep?.status??WizardStepStatus.NOT_STARTED,
    wizardLocked:Boolean(storyboardStep?.lockedAt)
  };
}


function clip(value:string,max:number):string{
  return value.slice(0,max);
}

function joined(a:string,b:string,max:number):string{
  if(!a) return clip(b,max);
  if(!b||a===b) return clip(a,max);
  return clip(a+"\n\n"+b,max);
}

function shotFieldsFromRecord(input:{
  shotVersion:{
    label:string|null;
    plannedStartMs:number|null;
    plannedEndMs:number|null;
    dramaticPurpose:string|null;
    subject:string|null;
    action:string|null;
    locationDescription:string|null;
    composition:string|null;
    cameraMotion:string|null;
    continuityNotes:string|null;
    transitionIn:string|null;
    transitionOut:string|null;
    structuredSpec:unknown;
  };
}){
  const spec=storyboardShotSpecSchema.parse(input.shotVersion.structuredSpec);
  return {
    label:input.shotVersion.label??"Storyboard shot",
    startMs:input.shotVersion.plannedStartMs??0,
    endMs:input.shotVersion.plannedEndMs??0,
    dramaticPurpose:input.shotVersion.dramaticPurpose??"",
    beat:spec.beat,
    subject:input.shotVersion.subject??"",
    action:input.shotVersion.action??"",
    environment:input.shotVersion.locationDescription??spec.environment,
    framingIntent:input.shotVersion.composition??spec.framingIntent,
    cameraIntent:input.shotVersion.cameraMotion??spec.cameraIntent,
    continuityNotes:input.shotVersion.continuityNotes??"",
    transitionIn:input.shotVersion.transitionIn??"",
    transitionOut:input.shotVersion.transitionOut??"",
    visualIntensity:spec.visualIntensity
  };
}

async function activeShotContext(
  tx:Tx,
  projectVersionId:string,
  shotVersionId:string
){
  const link=await tx.sequenceVersionShot.findFirst({
    where:{
      shotVersionId,
      sequenceVersion:{
        projectLinks:{some:{projectVersionId}}
      }
    },
    include:{
      shotVersion:true,
      sequenceVersion:true
    }
  });
  if(!link) throw new StoryboardError("Storyboard shot is not active.");
  if(link.shotVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("Only draft storyboard shots can be edited.");
  }
  return link;
}

async function createShotRevision(
  tx:Tx,
  input:{
    projectId:string;
    userId:string|null;
    shotId:string;
    sequenceVersionId:string;
    sequenceNodeId:string;
    sequencePosition:number;
    shotPosition:number;
    fields:{
      label:string;
      startMs:number;
      endMs:number;
      dramaticPurpose:string;
      beat:string;
      subject:string;
      action:string;
      environment:string;
      framingIntent:string;
      cameraIntent:string;
      continuityNotes:string;
      transitionIn:string;
      transitionOut:string;
      visualIntensity:number;
    };
    origin:"MANUAL"|"REGENERATED";
    generationJobId:string|null;
  }
){
  const latest=await tx.shotVersion.findFirst({
    where:{shotId:input.shotId},
    orderBy:{versionNumber:"desc"},
    select:{versionNumber:true}
  });
  const node=await tx.domainVersionNode.create({
    data:{kind:DomainVersionKind.SHOT}
  });
  const spec=storyboardShotSpecSchema.parse({
    schemaVersion:1,
    stage:"STORYBOARD",
    sourceSequenceVersionId:input.sequenceVersionId,
    sourceSequenceNodeId:input.sequenceNodeId,
    sourceSequencePosition:input.sequencePosition,
    sourceShotPosition:input.shotPosition,
    beat:input.fields.beat,
    environment:input.fields.environment,
    framingIntent:input.fields.framingIntent,
    cameraIntent:input.fields.cameraIntent,
    visualIntensity:input.fields.visualIntensity,
    origin:input.origin,
    generationJobId:input.generationJobId
  });
  const version=await tx.shotVersion.create({
    data:{
      shotId:input.shotId,
      nodeId:node.id,
      versionNumber:(latest?.versionNumber??0)+1,
      label:input.fields.label,
      plannedStartMs:input.fields.startMs,
      plannedEndMs:input.fields.endMs,
      dramaticPurpose:input.fields.dramaticPurpose,
      subject:input.fields.subject,
      locationDescription:input.fields.environment,
      action:input.fields.action,
      composition:input.fields.framingIntent,
      cameraMotion:input.fields.cameraIntent,
      continuityNotes:input.fields.continuityNotes,
      transitionIn:input.fields.transitionIn,
      transitionOut:input.fields.transitionOut,
      structuredSpec:toJson(spec),
      createdByUserId:input.userId
    }
  });
  const fingerprint=fingerprintJson(toJson({
    label:version.label,
    startMs:version.plannedStartMs,
    endMs:version.plannedEndMs,
    dramaticPurpose:version.dramaticPurpose,
    subject:version.subject,
    action:version.action,
    structuredSpec:spec
  }) as unknown as Prisma.JsonValue);
  await tx.domainVersionNode.update({
    where:{id:node.id},
    data:{fingerprint}
  });
  await registerDependencyEdgeInTransaction(tx,{
    upstreamNodeId:input.sequenceNodeId,
    downstreamNodeId:node.id,
    relation:DependencyRelation.REFERENCES,
    reason:"Storyboard edit remains derived from this exact locked SequenceVersion."
  });
  return version;
}

async function syncEditedStoryboard(tx:Tx,projectVersionId:string){
  const state=await serializeStoryboard(tx,projectVersionId);
  const wizard=await saveManagedWizardStepInTransaction(tx,{
    projectVersionId,
    stepKey:"storyboard",
    payload:await storyboardPayload(tx,projectVersionId),
    semanticFingerprint:storyboardFingerprint(state)
  });
  return {state,wizard};
}

function stateAsDocument(
  state:Awaited<ReturnType<typeof serializeStoryboard>>
):StoryboardDocument{
  return storyboardDocumentSchema.parse({
    sequences:state.sequences.map(sequence=>({
      sequenceVersionId:sequence.sequenceVersionId,
      shots:sequence.shots.map(shot=>({
        label:shot.label??"Storyboard shot",
        startMs:shot.startMs??0,
        endMs:shot.endMs??0,
        dramaticPurpose:shot.dramaticPurpose??"",
        beat:shot.beat,
        subject:shot.subject??"",
        action:shot.action??"",
        environment:shot.environment??"",
        framingIntent:shot.framingIntent??"",
        cameraIntent:shot.cameraIntent??"",
        continuityNotes:shot.continuityNotes??"",
        transitionIn:shot.transitionIn??"",
        transitionOut:shot.transitionOut??"",
        visualIntensity:shot.visualIntensity
      }))
    }))
  });
}

async function replaceSequenceLinks(
  tx:Tx,
  sequenceVersionId:string,
  shotVersionIds:string[]
){
  await tx.sequenceVersionShot.deleteMany({where:{sequenceVersionId}});
  if(shotVersionIds.length){
    await tx.sequenceVersionShot.createMany({
      data:shotVersionIds.map((shotVersionId,position)=>({
        sequenceVersionId,
        shotVersionId,
        position
      }))
    });
  }
}

async function markDraftSuperseded(tx:Tx,ids:string[]){
  if(!ids.length) return;
  await tx.shotVersion.updateMany({
    where:{id:{in:ids},lifecycle:VersionLifecycle.DRAFT},
    data:{lifecycle:VersionLifecycle.SUPERSEDED}
  });
}

export async function rewriteStoryboardShot(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  shotVersionId:string;
  fields:unknown;
}){
  const projectVersion=await ensureWizardProgress(input);
  const fields=storyboardRewriteFieldsSchema.parse(input.fields);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeStoryboardJob(tx,input.projectId)){
      throw new StoryboardError("Wait for storyboard generation to finish before editing.");
    }
    const link=await activeShotContext(tx,projectVersion.id,input.shotVersionId);
    const current=shotFieldsFromRecord(link);
    await markDraftSuperseded(tx,[link.shotVersion.id]);
    const revised=await createShotRevision(tx,{
      projectId:input.projectId,
      userId:input.userId,
      shotId:link.shotVersion.shotId,
      sequenceVersionId:link.sequenceVersion.id,
      sequenceNodeId:link.sequenceVersion.nodeId,
      sequencePosition:storyboardShotSpecSchema.parse(
        link.shotVersion.structuredSpec
      ).sourceSequencePosition,
      shotPosition:link.position,
      fields:{
        ...current,
        ...fields
      },
      origin:"MANUAL",
      generationJobId:null
    });
    await tx.sequenceVersionShot.update({
      where:{id:link.id},
      data:{shotVersionId:revised.id}
    });
    const synced=await syncEditedStoryboard(tx,projectVersion.id);
    return {
      storyboard:synced.state,
      impactWarnings:synced.wizard.impactWarnings
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

async function splitOrDuplicateStoryboardShot(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  shotVersionId:string;
  splitAtMs:number|null;
  duplicate:boolean;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeStoryboardJob(tx,input.projectId)){
      throw new StoryboardError("Wait for storyboard generation to finish before editing.");
    }
    const link=await activeShotContext(tx,projectVersion.id,input.shotVersionId);
    const allLinks=await tx.sequenceVersionShot.findMany({
      where:{sequenceVersionId:link.sequenceVersion.id},
      orderBy:{position:"asc"},
      include:{shotVersion:true}
    });
    const current=shotFieldsFromRecord(link);
    const splitAt=input.splitAtMs??
      Math.floor((current.startMs+current.endMs)/2);
    if(splitAt<=current.startMs||splitAt>=current.endMs){
      throw new StoryboardError("Split point must fall inside the shot.");
    }

    await markDraftSuperseded(tx,[link.shotVersion.id]);
    const sequencePosition=storyboardShotSpecSchema.parse(
      link.shotVersion.structuredSpec
    ).sourceSequencePosition;
    const first=await createShotRevision(tx,{
      projectId:input.projectId,
      userId:input.userId,
      shotId:link.shotVersion.shotId,
      sequenceVersionId:link.sequenceVersion.id,
      sequenceNodeId:link.sequenceVersion.nodeId,
      sequencePosition,
      shotPosition:link.position,
      fields:{
        ...current,
        label:input.duplicate?current.label:clip(current.label+" A",180),
        endMs:splitAt,
        transitionOut:""
      },
      origin:"MANUAL",
      generationJobId:null
    });
    const secondLogical=await tx.shot.create({
      data:{projectId:input.projectId}
    });
    const second=await createShotRevision(tx,{
      projectId:input.projectId,
      userId:input.userId,
      shotId:secondLogical.id,
      sequenceVersionId:link.sequenceVersion.id,
      sequenceNodeId:link.sequenceVersion.nodeId,
      sequencePosition,
      shotPosition:link.position+1,
      fields:{
        ...current,
        label:input.duplicate?clip(current.label+" copy",180):clip(current.label+" B",180),
        startMs:splitAt,
        transitionIn:""
      },
      origin:"MANUAL",
      generationJobId:null
    });

    const ids=allLinks.flatMap(item=>
      item.id===link.id
        ? [first.id,second.id]
        : [item.shotVersionId]
    );
    await replaceSequenceLinks(tx,link.sequenceVersion.id,ids);
    const synced=await syncEditedStoryboard(tx,projectVersion.id);
    return {
      storyboard:synced.state,
      impactWarnings:synced.wizard.impactWarnings
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function splitStoryboardShot(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  shotVersionId:string;
  splitAtMs:number;
}){
  return splitOrDuplicateStoryboardShot({...input,duplicate:false});
}

export async function duplicateStoryboardShot(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  shotVersionId:string;
}){
  return splitOrDuplicateStoryboardShot({
    ...input,
    splitAtMs:null,
    duplicate:true
  });
}

export async function mergeStoryboardShots(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  firstShotVersionId:string;
  secondShotVersionId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeStoryboardJob(tx,input.projectId)){
      throw new StoryboardError("Wait for storyboard generation to finish before editing.");
    }
    const first=await activeShotContext(
      tx,projectVersion.id,input.firstShotVersionId
    );
    const second=await activeShotContext(
      tx,projectVersion.id,input.secondShotVersionId
    );
    if(
      first.sequenceVersion.id!==second.sequenceVersion.id ||
      second.position!==first.position+1
    ){
      throw new StoryboardError("Only adjacent shots in the same sequence can be merged.");
    }
    const a=shotFieldsFromRecord(first);
    const b=shotFieldsFromRecord(second);
    if(a.endMs!==b.startMs){
      throw new StoryboardError("Merged shots must be temporally adjacent.");
    }
    const allLinks=await tx.sequenceVersionShot.findMany({
      where:{sequenceVersionId:first.sequenceVersion.id},
      orderBy:{position:"asc"}
    });
    await markDraftSuperseded(tx,[
      first.shotVersion.id,
      second.shotVersion.id
    ]);
    const sequencePosition=storyboardShotSpecSchema.parse(
      first.shotVersion.structuredSpec
    ).sourceSequencePosition;
    const merged=await createShotRevision(tx,{
      projectId:input.projectId,
      userId:input.userId,
      shotId:first.shotVersion.shotId,
      sequenceVersionId:first.sequenceVersion.id,
      sequenceNodeId:first.sequenceVersion.nodeId,
      sequencePosition,
      shotPosition:first.position,
      fields:{
        label:clip(a.label+" / "+b.label,180),
        startMs:a.startMs,
        endMs:b.endMs,
        dramaticPurpose:joined(a.dramaticPurpose,b.dramaticPurpose,4000),
        beat:joined(a.beat,b.beat,4000),
        subject:joined(a.subject,b.subject,3000),
        action:joined(a.action,b.action,4000),
        environment:joined(a.environment,b.environment,4000),
        framingIntent:joined(a.framingIntent,b.framingIntent,3000),
        cameraIntent:joined(a.cameraIntent,b.cameraIntent,3000),
        continuityNotes:joined(a.continuityNotes,b.continuityNotes,3000),
        transitionIn:a.transitionIn,
        transitionOut:b.transitionOut,
        visualIntensity:Math.round((a.visualIntensity+b.visualIntensity)/2)
      },
      origin:"MANUAL",
      generationJobId:null
    });
    const ids=allLinks
      .filter(item=>item.shotVersionId!==second.shotVersion.id)
      .map(item=>
        item.shotVersionId===first.shotVersion.id
          ? merged.id
          : item.shotVersionId
      );
    await replaceSequenceLinks(tx,first.sequenceVersion.id,ids);
    const synced=await syncEditedStoryboard(tx,projectVersion.id);
    return {
      storyboard:synced.state,
      impactWarnings:synced.wizard.impactWarnings
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function reorderStoryboardShots(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  sequenceVersionId:string;
  orderedShotVersionIds:string[];
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeStoryboardJob(tx,input.projectId)){
      throw new StoryboardError("Wait for storyboard generation to finish before editing.");
    }
    const sequenceLink=await tx.projectVersionSequence.findFirst({
      where:{
        projectVersionId:projectVersion.id,
        sequenceVersionId:input.sequenceVersionId
      },
      include:{sequenceVersion:true}
    });
    if(!sequenceLink) throw new StoryboardError("Sequence is not active in this storyboard.");
    const links=await tx.sequenceVersionShot.findMany({
      where:{sequenceVersionId:input.sequenceVersionId},
      orderBy:{position:"asc"},
      include:{shotVersion:true}
    });
    if(
      links.length!==input.orderedShotVersionIds.length ||
      new Set(input.orderedShotVersionIds).size!==links.length ||
      links.some(link=>!input.orderedShotVersionIds.includes(link.shotVersionId))
    ){
      throw new StoryboardError("Reorder must include every active shot exactly once.");
    }
    const byId=new Map(links.map(link=>[link.shotVersionId,link]));
    let cursor=sequenceLink.sequenceVersion.musicStartMs??0;
    const revisedIds:string[]=[];
    await markDraftSuperseded(tx,links.map(link=>link.shotVersionId));

    for(let position=0;position<input.orderedShotVersionIds.length;position++){
      const id=input.orderedShotVersionIds[position]!;
      const link=byId.get(id)!;
      const current=shotFieldsFromRecord(link);
      const duration=current.endMs-current.startMs;
      if(duration<=0) throw new StoryboardError("Storyboard shot has invalid duration.");
      const end=cursor+duration;
      const sequencePosition=storyboardShotSpecSchema.parse(
        link.shotVersion.structuredSpec
      ).sourceSequencePosition;
      const revised=await createShotRevision(tx,{
        projectId:input.projectId,
        userId:input.userId,
        shotId:link.shotVersion.shotId,
        sequenceVersionId:input.sequenceVersionId,
        sequenceNodeId:sequenceLink.sequenceVersion.nodeId,
        sequencePosition,
        shotPosition:position,
        fields:{
          ...current,
          startMs:cursor,
          endMs:end
        },
        origin:"MANUAL",
        generationJobId:null
      });
      revisedIds.push(revised.id);
      cursor=end;
    }
    const sequenceEnd=sequenceLink.sequenceVersion.musicEndMs??cursor;
    if(cursor!==sequenceEnd){
      const lastId=revisedIds.at(-1);
      if(!lastId) throw new StoryboardError("Storyboard sequence is empty.");
      await tx.shotVersion.update({
        where:{id:lastId},
        data:{plannedEndMs:sequenceEnd}
      });
    }
    await replaceSequenceLinks(tx,input.sequenceVersionId,revisedIds);
    const synced=await syncEditedStoryboard(tx,projectVersion.id);
    return {
      storyboard:synced.state,
      impactWarnings:synced.wizard.impactWarnings
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function completeStoryboard(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeStoryboardJob(tx,input.projectId)){
      throw new StoryboardError("Wait for storyboard generation to finish before completing.");
    }
    const state=await serializeStoryboard(tx,projectVersion.id);
    const document=stateAsDocument(state);
    const sequences=await activeSequences(tx,projectVersion.id);
    const issues=storyboardCompletionIssues(
      document,
      sequences.map(item=>({
        sequenceVersionId:item.version.id,
        startMs:item.version.musicStartMs??0,
        endMs:item.version.musicEndMs??0,
        targetShotCount:item.spec.targetShotCount
      }))
    );
    if(issues.length) throw new StoryboardError(issues.join(" "));
    const wizard=await completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:projectVersion.id,
      stepKey:"storyboard",
      payload:await storyboardPayload(tx,projectVersion.id),
      semanticFingerprint:storyboardFingerprint(state)
    });
    return {storyboard:state,impactWarnings:wizard.impactWarnings};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function reopenStoryboard(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(context.step.status!==WizardStepStatus.COMPLETED){
      return {
        storyboard:await serializeStoryboard(tx,projectVersion.id),
        impactWarnings:[]
      };
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
      data:{revision:{increment:1},currentStepKey:"storyboard"}
    });
    return {
      storyboard:await serializeStoryboard(tx,projectVersion.id),
      impactWarnings:[]
    };
  });
}

export async function lockStoryboard(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(context.step.status!==WizardStepStatus.COMPLETED){
      throw new StoryboardError("Complete the storyboard before locking it.");
    }
    const state=await serializeStoryboard(tx,projectVersion.id);
    const ids=state.sequences.flatMap(sequence=>
      sequence.shots.map(shot=>shot.shotVersionId)
    );
    if(!ids.length) throw new StoryboardError("Storyboard is empty.");
    const now=new Date();
    await tx.shotVersion.updateMany({
      where:{id:{in:ids},lifecycle:VersionLifecycle.DRAFT},
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
    return {
      storyboard:await serializeStoryboard(tx,projectVersion.id),
      impactWarnings:[]
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function queueStoryboardShotRegeneration(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  shotVersionId:string;
  direction:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  const configured=getConfiguredTextProvider(getEnvironment());
  const context=await db.$transaction(async tx=>{
    const current=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(await activeStoryboardJob(tx,input.projectId)){
      throw new StoryboardError("A storyboard generation job is already active.");
    }
    const link=await activeShotContext(tx,projectVersion.id,input.shotVersionId);
    return {
      progressId:current.progress.id,
      stepId:current.step.id,
      sequenceVersionId:link.sequenceVersion.id,
      sequenceNodeId:link.sequenceVersion.nodeId,
      shotNodeId:link.shotVersion.nodeId
    };
  });
  const request=queuedStoryboardShotRegenerationSchema.parse({
    textOperation:"storyboard-shot",
    projectId:input.projectId,
    projectVersionId:projectVersion.id,
    sequenceVersionId:context.sequenceVersionId,
    shotVersionId:input.shotVersionId,
    direction:input.direction
  });
  const workspace=await db.project.findUniqueOrThrow({
    where:{id:input.projectId},
    select:{workspaceId:true}
  });
  const job=await enqueueGenerationJob({
    workspaceId:workspace.workspaceId,
    projectId:input.projectId,
    kind:GenerationKind.TEXT,
    providerKey:configured.provider.key+":storyboard-shot",
    modelKey:configured.model,
    requestSnapshot:toJson(request),
    requestedByUserId:input.userId,
    inputs:[
      {nodeId:context.sequenceNodeId,role:"storyboard-sequence"},
      {nodeId:context.shotNodeId,role:"storyboard-shot"}
    ],
    prepare:async tx=>{
      await tx.wizardStepState.update({
        where:{id:context.stepId},
        data:{
          status:WizardStepStatus.IN_PROGRESS,
          completedAt:null,
          needsReviewAt:null,
          reviewReason:null
        }
      });
      await tx.wizardProgress.update({
        where:{id:context.progressId},
        data:{revision:{increment:1},currentStepKey:"storyboard"}
      });
    }
  });
  return {jobId:job.id,status:job.status};
}

export async function persistStoryboardShotRegeneration(input:{
  generationJobId:string;
  storyboardShot:unknown;
}){
  const fields=storyboardShotSchema.parse(input.storyboardShot);
  return db.$transaction(async tx=>{
    const job=await tx.generationJob.findUniqueOrThrow({
      where:{id:input.generationJobId}
    });
    const request=queuedStoryboardShotRegenerationSchema.parse(
      job.requestSnapshot
    );
    const link=await tx.sequenceVersionShot.findFirst({
      where:{
        sequenceVersionId:request.sequenceVersionId,
        shotVersionId:request.shotVersionId
      },
      include:{shotVersion:true,sequenceVersion:true}
    });
    if(!link){
      throw new StoryboardError(
        "Storyboard shot changed after targeted regeneration was queued."
      );
    }
    if(
      fields.startMs!==link.shotVersion.plannedStartMs ||
      fields.endMs!==link.shotVersion.plannedEndMs
    ){
      throw new StoryboardError(
        "Targeted storyboard regeneration must preserve exact shot timing."
      );
    }
    const existing=await tx.generationOutput.findFirst({
      where:{jobId:job.id,role:"storyboard-shot-regeneration"}
    });
    if(existing) return {shotVersionId:request.shotVersionId};

    await markDraftSuperseded(tx,[link.shotVersion.id]);
    const spec=storyboardShotSpecSchema.parse(link.shotVersion.structuredSpec);
    const revised=await createShotRevision(tx,{
      projectId:request.projectId,
      userId:job.requestedByUserId,
      shotId:link.shotVersion.shotId,
      sequenceVersionId:link.sequenceVersion.id,
      sequenceNodeId:link.sequenceVersion.nodeId,
      sequencePosition:spec.sourceSequencePosition,
      shotPosition:link.position,
      fields,
      origin:"REGENERATED",
      generationJobId:job.id
    });
    await tx.sequenceVersionShot.update({
      where:{id:link.id},
      data:{shotVersionId:revised.id}
    });
    await tx.generationOutput.create({
      data:{
        jobId:job.id,
        nodeId:revised.nodeId,
        role:"storyboard-shot-regeneration"
      }
    });
    await syncEditedStoryboard(tx,request.projectVersionId);
    return {shotVersionId:revised.id,nodeId:revised.nodeId};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
