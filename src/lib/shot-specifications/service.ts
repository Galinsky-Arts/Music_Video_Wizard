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
import { creativeLanguageDocumentSchema } from "@/lib/creative-language/schema";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { getEnvironment } from "@/lib/env";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import { sequenceSourceSpecSchema } from "@/lib/sequence-map/schema";
import { storyboardShotSpecSchema } from "@/lib/storyboard/schema";
import {
  getConfiguredTextProvider,
  textGenerationAvailable
} from "@/lib/text-generation/factory";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  WizardLockedError
} from "@/lib/wizard/service";
import { queuedShotSpecificationsGenerationSchema } from "./input";
import {
  generatedShotSpecificationsDocumentSchema,
  shotSpecificationCompletionIssues,
  shotSpecificationSpecSchema,
  type GeneratedShotSpecificationsDocument,
  type ShotSpecificationSpec
} from "./schema";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class ShotSpecificationsError extends Error {}
export class ShotSpecificationsConflictError extends ShotSpecificationsError {}

type Tx=Prisma.TransactionClient;

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function activeStoryboardSources(tx:Tx,projectVersionId:string){
  const sequenceLinks=await tx.projectVersionSequence.findMany({
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

  return sequenceLinks.flatMap(sequenceLink=>
    sequenceLink.sequenceVersion.shotLinks.map(shotLink=>({
      sequencePosition:sequenceLink.position,
      shotPosition:shotLink.position,
      sequenceVersion:sequenceLink.sequenceVersion,
      sequenceSpec:sequenceSourceSpecSchema.parse(
        sequenceLink.sequenceVersion.structuredSpec
      ),
      storyboardVersion:shotLink.shotVersion,
      storyboardSpec:storyboardShotSpecSchema.parse(
        shotLink.shotVersion.structuredSpec
      )
    }))
  );
}

async function latestLockedCreativeLanguage(tx:Tx,projectId:string){
  return tx.creativeLanguageVersion.findFirst({
    where:{
      lifecycle:VersionLifecycle.LOCKED,
      creativeLanguage:{projectId}
    },
    orderBy:{versionNumber:"desc"}
  });
}

function asShotSpecification(value:unknown):ShotSpecificationSpec|null{
  const parsed=shotSpecificationSpecSchema.safeParse(value);
  return parsed.success?parsed.data:null;
}

async function currentSpecificationVersions(
  tx:Tx,
  sources:Awaited<ReturnType<typeof activeStoryboardSources>>
){
  if(!sources.length) return [];
  const shotIds=[...new Set(sources.map(source=>source.storyboardVersion.shotId))];
  const candidates=await tx.shotVersion.findMany({
    where:{shotId:{in:shotIds}},
    orderBy:[{shotId:"asc"},{versionNumber:"desc"}]
  });
  const byShot=new Map<string,typeof candidates>();
  for(const candidate of candidates){
    const list=byShot.get(candidate.shotId)??[];
    list.push(candidate);
    byShot.set(candidate.shotId,list);
  }

  return sources.map(source=>{
    const version=(byShot.get(source.storyboardVersion.shotId)??[]).find(candidate=>{
      const spec=asShotSpecification(candidate.structuredSpec);
      return spec?.sourceStoryboardShotVersionId===source.storyboardVersion.id;
    })??null;
    const spec=version?asShotSpecification(version.structuredSpec):null;
    return {source,version,spec};
  });
}

function specificationFingerprint(input:{
  sourceStoryboardShotVersionId:string;
  sourceCreativeLanguageVersionId:string;
  specification:ShotSpecificationSpec;
}){
  return fingerprintJson(toJson(input) as unknown as Prisma.JsonValue);
}

async function wizardPayload(
  tx:Tx,
  projectVersionId:string
){
  const sources=await activeStoryboardSources(tx,projectVersionId);
  const current=await currentSpecificationVersions(tx,sources);
  return toJson({
    sourceStoryboardShotVersionIds:sources.map(item=>item.storyboardVersion.id),
    shotSpecificationVersionIds:current
      .map(item=>item.version?.id)
      .filter((value):value is string=>Boolean(value)),
    shotSpecificationNodeIds:current
      .map(item=>item.version?.nodeId)
      .filter((value):value is string=>Boolean(value)),
    shotCount:sources.length
  });
}

async function activeJob(tx:Tx,projectId:string){
  return tx.generationJob.findFirst({
    where:{
      projectId,
      kind:GenerationKind.TEXT,
      providerKey:{contains:":shot-specifications"},
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
  if(!progress){
    throw new ShotSpecificationsError("Shot Specifications wizard state not found.");
  }
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new ShotSpecificationsConflictError(
      "Shot Specifications changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(item=>item.stepKey==="shot-specifications");
  if(!step){
    throw new ShotSpecificationsError("Shot Specifications wizard step is unavailable.");
  }
  if(step.lockedAt){
    throw new WizardLockedError("Shot Specifications are locked.");
  }
  const storyboardStep=progress.steps.find(item=>item.stepKey==="storyboard");
  if(!storyboardStep?.lockedAt){
    throw new ShotSpecificationsError(
      "Lock the Storyboard before generating Shot Specifications."
    );
  }
  const creativeLanguageStep=progress.steps.find(
    item=>item.stepKey==="creative-language"
  );
  if(!creativeLanguageStep?.lockedAt){
    throw new ShotSpecificationsError(
      "Lock Creative Language before generating Shot Specifications."
    );
  }
  return {progress,step};
}

export async function queueShotSpecificationsGeneration(input:{
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
    if(await activeJob(tx,input.projectId)){
      throw new ShotSpecificationsError(
        "A Shot Specifications generation job is already active."
      );
    }
    const sources=await activeStoryboardSources(tx,projectVersion.id);
    if(!sources.length){
      throw new ShotSpecificationsError("The locked Storyboard is empty.");
    }
    if(
      sources.some(
        source=>source.storyboardVersion.lifecycle!==VersionLifecycle.LOCKED
      )
    ){
      throw new ShotSpecificationsError(
        "Every active Storyboard shot must be locked."
      );
    }
    const creativeLanguage=await latestLockedCreativeLanguage(
      tx,
      input.projectId
    );
    if(!creativeLanguage){
      throw new ShotSpecificationsError(
        "A locked Creative Language version is required."
      );
    }
    creativeLanguageDocumentSchema.parse(creativeLanguage.document);
    return {
      stepId:current.step.id,
      sources,
      creativeLanguage
    };
  });

  const request=queuedShotSpecificationsGenerationSchema.parse({
    textOperation:"shot-specifications",
    projectId:input.projectId,
    projectVersionId:projectVersion.id,
    sourceStoryboardShotVersionIds:context.sources.map(
      source=>source.storyboardVersion.id
    ),
    sourceCreativeLanguageVersionId:context.creativeLanguage.id,
    direction:input.direction
  });
  const project=await db.project.findUniqueOrThrow({
    where:{id:input.projectId},
    select:{workspaceId:true}
  });

  const job=await enqueueGenerationJob({
    workspaceId:project.workspaceId,
    projectId:input.projectId,
    kind:GenerationKind.TEXT,
    providerKey:configured.provider.key+":shot-specifications",
    modelKey:configured.model,
    requestSnapshot:toJson(request),
    requestedByUserId:input.userId,
    inputs:[
      {
        nodeId:context.creativeLanguage.nodeId,
        role:"creative-language",
        position:0
      },
      ...context.sources.map((source,position)=>({
        nodeId:source.storyboardVersion.nodeId,
        role:"storyboard-shot",
        position
      }))
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
    }
  });

  return {jobId:job.id,status:job.status};
}

export async function persistShotSpecificationsGeneration(input:{
  generationJobId:string;
  projectId:string;
  projectVersionId:string;
  sourceStoryboardShotVersionIds:string[];
  sourceCreativeLanguageVersionId:string;
  document:GeneratedShotSpecificationsDocument;
}){
  const document=generatedShotSpecificationsDocumentSchema.parse(input.document);
  const issues=shotSpecificationCompletionIssues(
    document,
    input.sourceStoryboardShotVersionIds
  );
  if(issues.length) throw new ShotSpecificationsError(issues.join(" "));

  return db.$transaction(async tx=>{
    const job=await tx.generationJob.findUniqueOrThrow({
      where:{id:input.generationJobId}
    });
    const request=queuedShotSpecificationsGenerationSchema.parse(
      job.requestSnapshot
    );
    if(
      request.projectId!==input.projectId ||
      request.projectVersionId!==input.projectVersionId ||
      request.sourceCreativeLanguageVersionId!==
        input.sourceCreativeLanguageVersionId ||
      request.sourceStoryboardShotVersionIds.length!==
        input.sourceStoryboardShotVersionIds.length ||
      request.sourceStoryboardShotVersionIds.some(
        (id,index)=>id!==input.sourceStoryboardShotVersionIds[index]
      )
    ){
      throw new ShotSpecificationsError(
        "Shot Specifications generation no longer matches its queued source."
      );
    }

    const sources=await activeStoryboardSources(tx,input.projectVersionId);
    const activeIds=sources.map(source=>source.storyboardVersion.id);
    if(
      activeIds.length!==input.sourceStoryboardShotVersionIds.length ||
      activeIds.some(
        (id,index)=>id!==input.sourceStoryboardShotVersionIds[index]
      ) ||
      sources.some(
        source=>source.storyboardVersion.lifecycle!==VersionLifecycle.LOCKED
      )
    ){
      throw new ShotSpecificationsError(
        "Storyboard changed after Shot Specifications generation was queued."
      );
    }

    const creativeLanguage=await tx.creativeLanguageVersion.findUniqueOrThrow({
      where:{id:input.sourceCreativeLanguageVersionId}
    });
    if(creativeLanguage.lifecycle!==VersionLifecycle.LOCKED){
      throw new ShotSpecificationsError(
        "Creative Language changed after Shot Specifications generation was queued."
      );
    }

    const existingOutput=await tx.generationOutput.findFirst({
      where:{jobId:input.generationJobId,role:"shot-specification"}
    });
    if(existingOutput){
      return {projectVersionId:input.projectVersionId};
    }

    const generatedBySource=new Map(
      document.specifications.map(item=>[
        item.sourceStoryboardShotVersionId,
        item
      ])
    );
    const created:Array<{id:string;nodeId:string}>=[];

    for(const source of sources){
      const generated=generatedBySource.get(source.storyboardVersion.id)!;
      const priorVersions=await tx.shotVersion.findMany({
        where:{shotId:source.storyboardVersion.shotId},
        orderBy:{versionNumber:"desc"}
      });
      const priorDraftSpecIds=priorVersions
        .filter(version=>
          version.lifecycle===VersionLifecycle.DRAFT &&
          Boolean(asShotSpecification(version.structuredSpec))
        )
        .map(version=>version.id);
      if(priorDraftSpecIds.length){
        await tx.shotVersion.updateMany({
          where:{id:{in:priorDraftSpecIds}},
          data:{lifecycle:VersionLifecycle.SUPERSEDED}
        });
      }
      const node=await tx.domainVersionNode.create({
        data:{kind:DomainVersionKind.SHOT}
      });
      const spec=shotSpecificationSpecSchema.parse({
        ...generated,
        schemaVersion:1,
        stage:"SHOT_SPECIFICATION",
        sourceStoryboardShotVersionId:source.storyboardVersion.id,
        sourceStoryboardShotNodeId:source.storyboardVersion.nodeId,
        sourceSequenceVersionId:source.sequenceVersion.id,
        sourceSequenceNodeId:source.sequenceVersion.nodeId,
        sourceSequencePosition:source.sequencePosition,
        sourceShotPosition:source.shotPosition,
        sourceCreativeLanguageVersionId:creativeLanguage.id,
        generationJobId:input.generationJobId,
        origin:"GENERATED"
      });
      const version=await tx.shotVersion.create({
        data:{
          shotId:source.storyboardVersion.shotId,
          nodeId:node.id,
          versionNumber:(priorVersions[0]?.versionNumber??0)+1,
          label:source.storyboardVersion.label,
          plannedStartMs:source.storyboardVersion.plannedStartMs,
          plannedEndMs:source.storyboardVersion.plannedEndMs,
          dramaticPurpose:source.storyboardVersion.dramaticPurpose,
          subject:source.storyboardVersion.subject,
          locationDescription:source.storyboardVersion.locationDescription,
          action:source.storyboardVersion.action,
          composition:generated.composition,
          framing:generated.framing,
          cameraAngle:generated.cameraAngle,
          lens:generated.lens,
          lighting:generated.lighting,
          colorTreatment:generated.colorTreatment,
          cameraMotion:generated.cameraMotion,
          subjectMotion:generated.subjectMotion,
          continuityNotes:generated.continuityNotes,
          wardrobeNotes:generated.wardrobeNotes,
          propsNotes:generated.propsNotes,
          transitionIn:generated.transitionIn,
          transitionOut:generated.transitionOut,
          negativeInstructions:generated.exclusions.join("\n"),
          generationHandlesMs:generated.generationHandlesMs,
          structuredSpec:toJson(spec),
          createdByUserId:job.requestedByUserId
        }
      });
      const fingerprint=specificationFingerprint({
        sourceStoryboardShotVersionId:source.storyboardVersion.id,
        sourceCreativeLanguageVersionId:creativeLanguage.id,
        specification:spec
      });
      await tx.domainVersionNode.update({
        where:{id:node.id},
        data:{fingerprint}
      });
      await registerDependencyEdgeInTransaction(tx,{
        upstreamNodeId:source.storyboardVersion.nodeId,
        downstreamNodeId:node.id,
        relation:DependencyRelation.COMPILED_FROM,
        reason:
          "Shot Specification compiles this exact locked Storyboard ShotVersion."
      });
      await registerDependencyEdgeInTransaction(tx,{
        upstreamNodeId:creativeLanguage.nodeId,
        downstreamNodeId:node.id,
        relation:DependencyRelation.REFERENCES,
        reason:
          "Shot Specification applies this exact locked Creative Language version."
      });
      await tx.generationOutput.create({
        data:{
          jobId:input.generationJobId,
          nodeId:node.id,
          role:"shot-specification",
          position:created.length
        }
      });
      created.push({id:version.id,nodeId:node.id});
    }

    const semanticFingerprint=fingerprintJson(toJson({
      sourceStoryboardShotVersionIds:input.sourceStoryboardShotVersionIds,
      sourceCreativeLanguageVersionId:input.sourceCreativeLanguageVersionId,
      shotSpecificationVersionIds:created.map(item=>item.id),
      shotSpecificationNodeIds:created.map(item=>item.nodeId)
    }) as unknown as Prisma.JsonValue);

    await completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:input.projectVersionId,
      stepKey:"shot-specifications",
      payload:await wizardPayload(tx,input.projectVersionId),
      semanticFingerprint
    });

    return {
      projectVersionId:input.projectVersionId,
      shotSpecificationCount:created.length
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function lockShotSpecifications(input:{
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
      throw new ShotSpecificationsError(
        "Generate complete Shot Specifications before locking them."
      );
    }
    if(await activeJob(tx,input.projectId)){
      throw new ShotSpecificationsError(
        "Wait for Shot Specifications generation to finish before locking."
      );
    }
    const sources=await activeStoryboardSources(tx,projectVersion.id);
    const current=await currentSpecificationVersions(tx,sources);
    if(
      !sources.length ||
      current.some(item=>!item.version||!item.spec)
    ){
      throw new ShotSpecificationsError(
        "Every locked Storyboard shot requires a current Shot Specification."
      );
    }
    const latestCreativeLanguage=await latestLockedCreativeLanguage(
      tx,
      input.projectId
    );
    if(
      !latestCreativeLanguage ||
      current.some(
        item=>
          item.spec!.sourceCreativeLanguageVersionId!==latestCreativeLanguage.id
      )
    ){
      throw new ShotSpecificationsError(
        "Regenerate Shot Specifications from the current locked Creative Language before locking."
      );
    }

    const now=new Date();
    const ids=current.map(item=>item.version!.id);
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
      specifications:(await currentSpecificationVersions(tx,sources)).map(item=>({
        sourceStoryboardShotVersionId:item.source.storyboardVersion.id,
        shotSpecificationVersionId:item.version!.id,
        lifecycle:VersionLifecycle.LOCKED,
        specification:item.spec!
      })),
      impactWarnings:[]
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getShotSpecificationsState(input:{
  userId:string;
  projectId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  const progress=projectVersion.wizardProgress!;
  const storyboardStep=progress.steps.find(step=>step.stepKey==="storyboard");
  const shotSpecificationsStep=progress.steps.find(
    step=>step.stepKey==="shot-specifications"
  );
  const sources=await activeStoryboardSources(db,projectVersion.id);
  const current=await currentSpecificationVersions(db,sources);
  const creativeLanguage=await latestLockedCreativeLanguage(
    db,
    input.projectId
  );

  const recentJob=await db.generationJob.findFirst({
    where:{
      projectId:input.projectId,
      kind:GenerationKind.TEXT,
      providerKey:{contains:":shot-specifications"}
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
    storyboardStep?.lockedAt &&
    creativeLanguage &&
    creativeLanguage.lifecycle===VersionLifecycle.LOCKED &&
    sources.length>0 &&
    sources.every(
      source=>source.storyboardVersion.lifecycle===VersionLifecycle.LOCKED
    )
  );
  const needsRegeneration=Boolean(
    sourceReady &&
    (
      current.some(item=>!item.version||!item.spec) ||
      current.some(
        item=>
          item.spec?.sourceCreativeLanguageVersionId!==creativeLanguage!.id
      )
    )
  );

  return {
    sourceReady,
    providerAvailable,
    needsRegeneration,
    recentJob,
    sourceCreativeLanguageVersionId:creativeLanguage?.id??null,
    specifications:current
      .filter(
        (item):item is typeof item & {
          version:NonNullable<typeof item.version>;
          spec:NonNullable<typeof item.spec>;
        }=>Boolean(item.version&&item.spec)
      )
      .map(item=>({
        sequencePosition:item.source.sequencePosition,
        shotPosition:item.source.shotPosition,
        label:item.source.storyboardVersion.label,
        startMs:item.source.storyboardVersion.plannedStartMs,
        endMs:item.source.storyboardVersion.plannedEndMs,
        sourceStoryboardShotVersionId:item.source.storyboardVersion.id,
        sourceStoryboardShotNodeId:item.source.storyboardVersion.nodeId,
        shotSpecificationVersionId:item.version.id,
        shotSpecificationNodeId:item.version.nodeId,
        versionNumber:item.version.versionNumber,
        lifecycle:item.version.lifecycle,
        lockedAt:item.version.lockedAt,
        specification:item.spec
      })),
    expectedShotCount:sources.length,
    wizardRevision:progress.revision,
    wizardStatus:
      shotSpecificationsStep?.status??WizardStepStatus.NOT_STARTED,
    wizardLocked:Boolean(shotSpecificationsStep?.lockedAt)
  };
}
