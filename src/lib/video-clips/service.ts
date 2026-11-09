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
import { queuedVideoClipGenerationSchema } from "./input";
import {
  currentVideoClipVersions,
  lockedVideoClipSources,
  videoClipAssetsForProject
} from "./source";

export class VideoClipsError extends Error{}
export class VideoClipsConflictError extends VideoClipsError{}

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function activeVideoJobs(
  tx:Prisma.TransactionClient,
  projectId:string
){
  return tx.generationJob.findMany({
    where:{
      projectId,
      kind:GenerationKind.VIDEO,
      providerKey:{contains:":video-clip"},
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
  if(!progress) throw new VideoClipsError("Video Clips wizard state not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new VideoClipsConflictError(
      "Video Clips changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(item=>item.stepKey==="video-clips");
  if(!step) throw new VideoClipsError("Video Clips wizard step is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("Video Clips are locked.");
  const sourceStep=progress.steps.find(item=>item.stepKey==="initial-frames");
  if(!sourceStep?.lockedAt){
    throw new VideoClipsError(
      "Lock Initial Frames before generating Video Clips."
    );
  }
  return {progress,step};
}

async function configuredModels(){
  let adapters;
  try{
    adapters=getConfiguredMediaGenerationAdapters(getEnvironment());
  }catch(error){
    throw new VideoClipsError(
      error instanceof Error?error.message:"Video generation is not configured."
    );
  }
  const models=(await Promise.all(
    adapters.map(adapter=>adapter.listModels())
  )).flat();
  if(!models.length){
    throw new VideoClipsError("No video-generation model is configured.");
  }
  return models;
}

export async function queueVideoClipsGeneration(input:{
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
    if((await activeVideoJobs(tx,input.projectId)).length){
      throw new VideoClipsError(
        "Wait for the active Video Clips generation batch to finish."
      );
    }

    const sources=await lockedVideoClipSources(
      tx,
      input.projectId,
      projectVersion.id
    );
    if(!sources.length){
      throw new VideoClipsError("No locked Initial Frames are available.");
    }
    if(sources.some(item=>
      !item.source.specificationVersion||
      !item.source.specification||
      item.source.specificationVersion.lifecycle!==VersionLifecycle.LOCKED||
      !item.version
    )){
      throw new VideoClipsError(
        "Every shot requires a locked Shot Specification and current Initial Frame."
      );
    }

    const requested=new Set(input.shotSpecificationVersionIds);
    if(requested.size!==input.shotSpecificationVersionIds.length){
      throw new VideoClipsError("Video Clips request contains duplicate specifications.");
    }
    const target=input.shotSpecificationVersionIds.length
      ?sources.filter(item=>
        requested.has(item.source.specificationVersion!.id)
      )
      :sources;
    if(target.length!==(input.shotSpecificationVersionIds.length||sources.length)){
      throw new VideoClipsError(
        "One or more requested Shot Specifications are not current locked sources."
      );
    }

    const aspectRatio=current.progress.projectVersion.aspectRatio;
    const frameRate=current.progress.projectVersion.frameRate;
    if(!aspectRatio||!frameRate){
      throw new VideoClipsError(
        "Project aspect ratio and frame rate are required for Video Clips."
      );
    }
    const workspaceId=(await tx.project.findUniqueOrThrow({
      where:{id:input.projectId},
      select:{workspaceId:true}
    })).workspaceId;

    return {
      stepId:current.step.id,
      workspaceId,
      aspectRatio,
      frameRate,
      target
    };
  });

  const models=await configuredModels();
  const plans=context.target.map(item=>{
    const version=item.source.specificationVersion!;
    const specification=item.source.specification!;
    const start=item.source.storyboardVersion.plannedStartMs??0;
    const end=item.source.storyboardVersion.plannedEndMs??start+1;
    const request=compileShotGenerationRequest({
      sourceShotSpecificationVersionId:version.id,
      sourceStoryboardShotVersionId:
        specification.sourceStoryboardShotVersionId,
      shot:specification,
      mediaKind:"VIDEO",
      editorialDurationMs:Math.max(1,end-start),
      aspectRatio:context.aspectRatio,
      frameRate:context.frameRate,
      referenceDescriptions:[{
        role:"FIRST_FRAME",
        required:true,
        description:"Approved locked Initial Frame"
      }]
    });
    let model;
    try{
      model=requireMediaModel(models,request);
    }catch(error){
      throw new VideoClipsError(
        error instanceof Error?error.message:"No video model can satisfy this shot."
      );
    }
    return {item,version,specification,request,model};
  });

  const jobs=[];
  for(const plan of plans){
    const frame=plan.item.version!;
    const queued=queuedVideoClipGenerationSchema.parse({
      projectId:input.projectId,
      projectVersionId:projectVersion.id,
      shotSpecificationVersionId:plan.version.id,
      shotSpecificationNodeId:plan.version.nodeId,
      sourceStoryboardShotVersionId:
        plan.specification.sourceStoryboardShotVersionId,
      initialFrameAssetVersionId:frame.id,
      initialFrameNodeId:frame.nodeId,
      request:plan.request
    });
    const job=await enqueueGenerationJob({
      workspaceId:context.workspaceId,
      projectId:input.projectId,
      kind:GenerationKind.VIDEO,
      providerKey:plan.model.providerId+":video-clip",
      modelKey:plan.model.modelId,
      requestSnapshot:toJson(queued),
      requestedByUserId:input.userId,
      inputs:[
        {nodeId:plan.version.nodeId,role:"shot-specification",position:0},
        {nodeId:frame.nodeId,role:"initial-frame",position:0}
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
    jobs.push({jobId:job.id,status:job.status});
  }

  return {jobs};
}

export async function completeVideoClipsIfCovered(
  tx:Prisma.TransactionClient,
  input:{projectId:string;projectVersionId:string}
){
  const sources=await lockedVideoClipSources(
    tx,input.projectId,input.projectVersionId
  );
  if(
    !sources.length||
    sources.some(item=>
      !item.source.specificationVersion||
      !item.version
    )
  ) return false;

  const assets=await videoClipAssetsForProject(tx,input.projectId);
  const current=currentVideoClipVersions(sources,assets);
  if(current.some(item=>!item.version)) return false;

  const payload=toJson({
    sourceShotSpecificationVersionIds:sources.map(
      item=>item.source.specificationVersion!.id
    ),
    sourceInitialFrameAssetVersionIds:sources.map(item=>item.version!.id),
    videoClipAssetVersionIds:current.map(item=>item.version!.id),
    clipCount:current.length
  });
  const semanticFingerprint=fingerprintJson(
    payload as unknown as Prisma.JsonValue
  );

  await completeAutomaticWizardStepInTransaction(tx,{
    projectVersionId:input.projectVersionId,
    stepKey:"video-clips",
    payload,
    semanticFingerprint
  });
  return true;
}

export async function lockVideoClips(input:{
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
    if((await activeVideoJobs(tx,input.projectId)).length){
      throw new VideoClipsError(
        "Wait for Video Clips generation to finish before locking."
      );
    }
    const sources=await lockedVideoClipSources(
      tx,input.projectId,projectVersion.id
    );
    const assets=await videoClipAssetsForProject(tx,input.projectId);
    const current=currentVideoClipVersions(sources,assets);
    if(
      !sources.length||
      sources.some(item=>!item.source.specificationVersion||!item.version)||
      current.some(item=>!item.version)
    ){
      throw new VideoClipsError(
        "Every locked Initial Frame requires a current generated Video Clip."
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
    return {clipCount:current.length};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getVideoClipsState(input:{
  userId:string;
  projectId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  const snapshot=await db.$transaction(async tx=>{
    const progress=await tx.wizardProgress.findUniqueOrThrow({
      where:{projectVersionId:projectVersion.id},
      include:{steps:true}
    });
    const sourceStep=progress.steps.find(step=>step.stepKey==="initial-frames");
    const clipStep=progress.steps.find(step=>step.stepKey==="video-clips");
    const sources=await lockedVideoClipSources(
      tx,input.projectId,projectVersion.id
    );
    const assets=await videoClipAssetsForProject(tx,input.projectId);
    const current=currentVideoClipVersions(sources,assets);
    const recentJobs=await tx.generationJob.findMany({
      where:{
        projectId:input.projectId,
        kind:GenerationKind.VIDEO,
        providerKey:{contains:":video-clip"}
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
          item.source.specificationVersion?.lifecycle===
            VersionLifecycle.LOCKED&&
          Boolean(item.version)
        )
      ),
      needsRegeneration:Boolean(
        sourceStep?.lockedAt&&current.some(item=>!item.version)
      ),
      expectedClipCount:sources.length,
      wizardRevision:progress.revision,
      wizardStatus:clipStep?.status??WizardStepStatus.NOT_STARTED,
      wizardLocked:Boolean(clipStep?.lockedAt),
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
    providerAvailable=models.some(model=>model.capabilities.imageToVideo);
  }catch{}

  const storage=createAssetStorage();
  const clips=await Promise.all(snapshot.current.map(async item=>{
    const version=item.version;
    return {
      sequencePosition:item.source.source.sequencePosition,
      shotPosition:item.source.source.shotPosition,
      label:item.source.source.storyboardVersion.label,
      shotSpecificationVersionId:
        item.source.source.specificationVersion?.id??null,
      initialFrameAssetVersionId:item.source.version?.id??null,
      sourceStoryboardShotVersionId:
        item.source.source.storyboardVersion.id,
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
    expectedClipCount:snapshot.expectedClipCount,
    clips,
    recentJobs:snapshot.recentJobs,
    wizardRevision:snapshot.wizardRevision,
    wizardStatus:snapshot.wizardStatus,
    wizardLocked:snapshot.wizardLocked
  };
}
