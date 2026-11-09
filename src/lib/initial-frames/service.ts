import {
  GenerationKind,
  GenerationStatus,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { getEnvironment } from "@/lib/env";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import { getConfiguredMediaGenerationAdapters } from "@/lib/media-generation/factory";
import { requireMediaModel } from "@/lib/media-generation/selection";
import { compileShotGenerationRequest } from "@/lib/prompt-compiler/compiler";
import { createAssetStorage } from "@/lib/storage";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  WizardLockedError
} from "@/lib/wizard/service";
import {
  queuedInitialFrameGenerationSchema
} from "./input";
import {
  currentFrameVersions,
  initialFrameAssetsForProject,
  lockedShotSpecificationSources
} from "./source";

export class InitialFramesError extends Error{}
export class InitialFramesConflictError extends InitialFramesError{}

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function activeInitialFrameJobs(
  tx:Prisma.TransactionClient,
  projectId:string
){
  return tx.generationJob.findMany({
    where:{
      projectId,
      kind:GenerationKind.IMAGE,
      providerKey:{contains:":initial-frame"},
      status:{in:[GenerationStatus.QUEUED,GenerationStatus.RUNNING]}
    },
    orderBy:{createdAt:"asc"}
  });
}

async function mutationContext(tx:Prisma.TransactionClient,input:{
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
        project:{workspace:{memberships:{some:{userId:input.userId}}}}
      }
    },
    include:{projectVersion:true,steps:true}
  });
  if(!progress) throw new InitialFramesError("Initial Frames wizard state not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new InitialFramesConflictError(
      "Initial Frames changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(item=>item.stepKey==="initial-frames");
  if(!step) throw new InitialFramesError("Initial Frames wizard step is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("Initial Frames are locked.");
  const sourceStep=progress.steps.find(item=>item.stepKey==="shot-specifications");
  if(!sourceStep?.lockedAt){
    throw new InitialFramesError(
      "Lock Shot Specifications before generating Initial Frames."
    );
  }
  return {progress,step};
}

async function configuredModels(){
  let adapters;
  try{
    adapters=getConfiguredMediaGenerationAdapters(getEnvironment());
  }catch(error){
    throw new InitialFramesError(
      error instanceof Error?error.message:"Image generation is not configured."
    );
  }
  if(!adapters.length){
    throw new InitialFramesError("No image-generation provider is configured.");
  }
  const models=(await Promise.all(
    adapters.map(adapter=>adapter.listModels())
  )).flat().filter(model=>model.capabilities.textToImage);
  if(!models.length){
    throw new InitialFramesError("No image-generation model is configured.");
  }
  return models;
}

export async function queueInitialFramesGeneration(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  shotSpecificationVersionIds:string[];
}){
  const projectVersion=await ensureWizardProgress(input);

  const context=await db.$transaction(async tx=>{
    const current=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if((await activeInitialFrameJobs(tx,input.projectId)).length){
      throw new InitialFramesError(
        "Wait for the active Initial Frames generation batch to finish."
      );
    }
    const sources=await lockedShotSpecificationSources(tx,projectVersion.id);
    if(!sources.length){
      throw new InitialFramesError("No locked Shot Specifications are available.");
    }
    if(sources.some(item=>
      !item.specificationVersion||
      !item.specification||
      item.specificationVersion.lifecycle!==VersionLifecycle.LOCKED
    )){
      throw new InitialFramesError(
        "Every Storyboard shot requires a locked current Shot Specification."
      );
    }

    const requested=new Set(input.shotSpecificationVersionIds);
    if(requested.size!==input.shotSpecificationVersionIds.length){
      throw new InitialFramesError("Initial Frames request contains duplicate specifications.");
    }
    const target=input.shotSpecificationVersionIds.length
      ?sources.filter(item=>requested.has(item.specificationVersion!.id))
      :sources;
    if(target.length!==(input.shotSpecificationVersionIds.length||sources.length)){
      throw new InitialFramesError(
        "One or more requested Shot Specifications are not current locked sources."
      );
    }

    const aspectRatio=current.progress.projectVersion.aspectRatio;
    const frameRate=current.progress.projectVersion.frameRate;
    if(!aspectRatio||!frameRate){
      throw new InitialFramesError(
        "Project aspect ratio and frame rate are required for Initial Frames."
      );
    }

    return {
      stepId:current.step.id,
      workspaceId:await tx.project.findUniqueOrThrow({
        where:{id:input.projectId},
        select:{workspaceId:true}
      }).then(project=>project.workspaceId),
      aspectRatio,
      frameRate,
      target
    };
  });

  const models=await configuredModels();
  const plans=context.target.map(item=>{
    const version=item.specificationVersion!;
    const specification=item.specification!;
    const start=item.storyboardVersion.plannedStartMs??0;
    const end=item.storyboardVersion.plannedEndMs??start+1;
    const request=compileShotGenerationRequest({
      sourceShotSpecificationVersionId:version.id,
      sourceStoryboardShotVersionId:specification.sourceStoryboardShotVersionId,
      shot:specification,
      mediaKind:"IMAGE",
      editorialDurationMs:Math.max(1,end-start),
      aspectRatio:context.aspectRatio,
      frameRate:context.frameRate
    });
    let model;
    try{
      model=requireMediaModel(models,request);
    }catch(error){
      throw new InitialFramesError(
        error instanceof Error?error.message:"No image model can satisfy this shot."
      );
    }
    return {item,version,specification,request,model};
  });

  const jobs=[];
  for(const plan of plans){
    const queued=queuedInitialFrameGenerationSchema.parse({
      projectId:input.projectId,
      projectVersionId:projectVersion.id,
      shotSpecificationVersionId:plan.version.id,
      shotSpecificationNodeId:plan.version.nodeId,
      sourceStoryboardShotVersionId:
        plan.specification.sourceStoryboardShotVersionId,
      request:plan.request
    });
    const job=await enqueueGenerationJob({
      workspaceId:context.workspaceId,
      projectId:input.projectId,
      kind:GenerationKind.IMAGE,
      providerKey:plan.model.providerId+":initial-frame",
      modelKey:plan.model.modelId,
      requestSnapshot:toJson(queued),
      requestedByUserId:input.userId,
      inputs:[{
        nodeId:plan.version.nodeId,
        role:"shot-specification",
        position:0
      }],
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
    jobs.push({jobId:job.id,status:job.status});
  }

  return {jobs};
}

export async function completeInitialFramesIfCovered(
  tx:Prisma.TransactionClient,
  input:{projectId:string;projectVersionId:string}
){
  const sources=await lockedShotSpecificationSources(tx,input.projectVersionId);
  if(
    !sources.length||
    sources.some(item=>
      !item.specificationVersion||
      !item.specification||
      item.specificationVersion.lifecycle!==VersionLifecycle.LOCKED
    )
  ) return false;

  const assets=await initialFrameAssetsForProject(tx,input.projectId);
  const current=currentFrameVersions(sources,assets);
  if(current.some(item=>!item.version)) return false;

  const payload=toJson({
    sourceShotSpecificationVersionIds:sources.map(
      item=>item.specificationVersion!.id
    ),
    initialFrameAssetVersionIds:current.map(item=>item.version!.id),
    frameCount:current.length
  });
  const semanticFingerprint=fingerprintJson(payload as unknown as Prisma.JsonValue);

  await completeAutomaticWizardStepInTransaction(tx,{
    projectVersionId:input.projectVersionId,
    stepKey:"initial-frames",
    payload,
    semanticFingerprint
  });
  return true;
}

export async function lockInitialFrames(input:{
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
    if((await activeInitialFrameJobs(tx,input.projectId)).length){
      throw new InitialFramesError(
        "Wait for Initial Frames generation to finish before locking."
      );
    }
    const sources=await lockedShotSpecificationSources(tx,projectVersion.id);
    const assets=await initialFrameAssetsForProject(tx,input.projectId);
    const current=currentFrameVersions(sources,assets);
    if(
      !sources.length||
      sources.some(item=>
        !item.specificationVersion||
        item.specificationVersion.lifecycle!==VersionLifecycle.LOCKED
      )||
      current.some(item=>!item.version)
    ){
      throw new InitialFramesError(
        "Every locked Shot Specification requires a current generated Initial Frame."
      );
    }

    const now=new Date();
    await tx.wizardStepState.update({
      where:{id:context.step.id},
      data:{
        status:WizardStepStatus.COMPLETED,
        completedAt:context.step.completedAt??now,
        lockedAt:now
      }
    });
    await tx.wizardProgress.update({
      where:{id:context.progress.id},
      data:{revision:{increment:1}}
    });
    return {frameCount:current.length};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getInitialFramesState(input:{
  userId:string;
  projectId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  const snapshot=await db.$transaction(async tx=>{
    const progress=await tx.wizardProgress.findUniqueOrThrow({
      where:{projectVersionId:projectVersion.id},
      include:{steps:true}
    });
    const sourceStep=progress.steps.find(
      step=>step.stepKey==="shot-specifications"
    );
    const frameStep=progress.steps.find(step=>step.stepKey==="initial-frames");
    const sources=await lockedShotSpecificationSources(tx,projectVersion.id);
    const assets=await initialFrameAssetsForProject(tx,input.projectId);
    const current=currentFrameVersions(sources,assets);
    const recentJobs=await tx.generationJob.findMany({
      where:{
        projectId:input.projectId,
        kind:GenerationKind.IMAGE,
        providerKey:{contains:":initial-frame"}
      },
      orderBy:{createdAt:"desc"},
      take:100,
      select:{
        id:true,
        status:true,
        progressPercent:true,
        progressMessage:true,
        errorMessage:true,
        modelKey:true,
        providerKey:true,
        requestSnapshot:true
      }
    });

    return {
      sourceReady:Boolean(
        sourceStep?.lockedAt&&
        sources.length&&
        sources.every(item=>
          item.specificationVersion?.lifecycle===VersionLifecycle.LOCKED
        )
      ),
      needsRegeneration:Boolean(
        sourceStep?.lockedAt&&
        current.some(item=>!item.version)
      ),
      expectedFrameCount:sources.length,
      wizardRevision:progress.revision,
      wizardStatus:frameStep?.status??WizardStepStatus.NOT_STARTED,
      wizardLocked:Boolean(frameStep?.lockedAt),
      current,
      recentJobs
    };
  });

  let providerAvailable=false;
  try{
    const adapters=getConfiguredMediaGenerationAdapters(getEnvironment());
    const models=(await Promise.all(
      adapters.map(adapter=>adapter.listModels())
    )).flat();
    providerAvailable=models.some(model=>model.capabilities.textToImage);
  }catch{}

  const storage=createAssetStorage();
  const frames=await Promise.all(snapshot.current.map(async item=>{
    const version=item.version;
    return {
      sequencePosition:item.source.sequencePosition,
      shotPosition:item.source.shotPosition,
      label:item.source.storyboardVersion.label,
      shotSpecificationVersionId:item.source.specificationVersion?.id??null,
      sourceStoryboardShotVersionId:item.source.storyboardVersion.id,
      assetId:item.asset?.id??null,
      assetVersionId:version?.id??null,
      assetVersionNumber:version?.versionNumber??null,
      url:version
        ?await storage.getSignedReadUrl(version.storageKey,60*30)
        :null,
      contentType:version?.contentType??null,
      origin:(version?.metadata as Record<string,unknown>|null)?.origin==="import"?"import":"generated",
      createdAt:version?.createdAt??null
    };
  }));

  return {
    maxMediaUploadBytes:getEnvironment().MAX_MEDIA_UPLOAD_BYTES,
    sourceReady:snapshot.sourceReady,
    providerAvailable,
    needsRegeneration:snapshot.needsRegeneration,
    expectedFrameCount:snapshot.expectedFrameCount,
    frames,
    recentJobs:snapshot.recentJobs,
    wizardRevision:snapshot.wizardRevision,
    wizardStatus:snapshot.wizardStatus,
    wizardLocked:snapshot.wizardLocked
  };
}
