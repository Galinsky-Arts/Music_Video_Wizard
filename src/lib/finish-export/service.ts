import { randomUUID } from "node:crypto";
import {
  AssetKind,
  AssetStatus,
  GenerationKind,
  GenerationStatus,
  Prisma,
  TimelineKind,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import { createAssetStorage } from "@/lib/storage";
import {
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import {
  compileRenderManifest,
  type RenderManifest,
  type RenderSourceTransition
} from "./manifest";

export class FinishExportError extends Error{}
export class FinishExportConflictError extends FinishExportError{}

type Tx=Prisma.TransactionClient;

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function renderMetadata(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value)) return null;
  const item=value as Record<string,unknown>;
  if(
    item.role!=="render-master"||
    typeof item.manifestFingerprint!=="string"||
    typeof item.sourceTimelineVersionId!=="string"||
    typeof item.generationJobId!=="string"
  ) return null;
  return {
    role:"render-master" as const,
    manifestFingerprint:item.manifestFingerprint,
    sourceTimelineVersionId:item.sourceTimelineVersionId,
    generationJobId:item.generationJobId
  };
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
        project:{workspace:{memberships:{some:{userId:input.userId}}}}
      }
    },
    include:{projectVersion:true,steps:true}
  });
  if(!progress) throw new FinishExportError("Finish & Export wizard state not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new FinishExportConflictError(
      "Finish & Export changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(item=>item.stepKey==="finish-export");
  if(!step) throw new FinishExportError("Finish & Export wizard step is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("Finish & Export is locked.");
  const sourceStep=progress.steps.find(item=>item.stepKey==="refinement");
  if(!sourceStep?.lockedAt){
    throw new FinishExportError(
      "Lock Refinement before preparing Finish & Export."
    );
  }
  return {progress,step};
}

async function lockedRefinement(tx:Tx,projectId:string){
  const timeline=await tx.timeline.findFirst({
    where:{projectId,kind:TimelineKind.WORKING},
    orderBy:{createdAt:"asc"}
  });
  if(!timeline) return null;
  return tx.timelineVersion.findFirst({
    where:{
      timelineId:timeline.id,
      lifecycle:VersionLifecycle.LOCKED
    },
    orderBy:{versionNumber:"desc"},
    include:{
      node:true,
      items:{
        orderBy:[{trackIndex:"asc"},{position:"asc"}],
        include:{assetVersion:true}
      },
      transitions:true
    }
  });
}

async function compileCurrentManifest(
  tx:Tx,
  input:{
    projectId:string;
    projectVersionId:string;
  }
):Promise<RenderManifest>{
  const projectVersion=await tx.projectVersion.findUnique({
    where:{id:input.projectVersionId}
  });
  if(
    !projectVersion||
    projectVersion.projectId!==input.projectId
  ){
    throw new FinishExportError("Project version not found.");
  }
  if(
    !projectVersion.outputWidth||
    !projectVersion.outputHeight||
    !projectVersion.frameRate||
    !projectVersion.aspectRatio||
    !projectVersion.audioMasterAssetVersionId
  ){
    throw new FinishExportError(
      "Project delivery dimensions, frame rate, aspect ratio, and audio master are required."
    );
  }

  const source=await lockedRefinement(tx,input.projectId);
  if(!source){
    throw new FinishExportError("Locked Refinement timeline not found.");
  }
  if(source.basisProjectVersionId!==projectVersion.id){
    throw new FinishExportError(
      "Locked Refinement timeline belongs to a different ProjectVersion."
    );
  }

  const audio=await tx.assetVersion.findFirst({
    where:{
      id:projectVersion.audioMasterAssetVersionId,
      status:AssetStatus.READY,
      asset:{projectId:input.projectId}
    }
  });
  if(!audio){
    throw new FinishExportError(
      "The immutable audio master is not ready for rendering."
    );
  }

  const idToPosition=new Map(
    source.items.map(item=>[item.id,item.position])
  );
  const transitions:RenderSourceTransition[]=source.transitions.map(
    transition=>{
      const fromPosition=idToPosition.get(transition.fromItemId);
      const toPosition=idToPosition.get(transition.toItemId);
      if(fromPosition===undefined||toPosition===undefined){
        throw new FinishExportError(
          "Refinement transition references a missing timeline item."
        );
      }
      return {
        fromPosition,
        toPosition,
        kind:transition.kind,
        durationMs:transition.durationMs,
        parameters:transition.parameters
      };
    }
  );

  try{
    return compileRenderManifest({
      projectVersionId:projectVersion.id,
      sourceTimelineVersionId:source.id,
      sourceTimelineNodeId:source.nodeId,
      audioMasterAssetVersionId:audio.id,
      audioMasterNodeId:audio.nodeId,
      audioContentType:audio.contentType,
      audioDurationMs:audio.durationMs,
      width:projectVersion.outputWidth,
      height:projectVersion.outputHeight,
      frameRate:projectVersion.frameRate,
      aspectRatio:projectVersion.aspectRatio,
      items:source.items.map(item=>{
        if(
          !item.shotVersionId||
          !item.assetVersionId||
          !item.assetVersion
        ){
          throw new FinishExportError(
            "Refinement timeline contains an incomplete video item."
          );
        }
        if(item.sourceEndMs===null){
          throw new FinishExportError(
            "Refinement timeline contains an open-ended source range."
          );
        }
        return {
          position:item.position,
          shotVersionId:item.shotVersionId,
          clipAssetVersionId:item.assetVersionId,
          clipNodeId:item.assetVersion.nodeId,
          contentType:item.assetVersion.contentType,
          timelineStartMs:item.timelineStartMs,
          timelineEndMs:item.timelineEndMs,
          sourceStartMs:item.sourceStartMs,
          sourceEndMs:item.sourceEndMs,
          clipDurationMs:item.assetVersion.durationMs
        };
      }),
      transitions
    });
  }catch(error){
    if(error instanceof FinishExportError) throw error;
    throw new FinishExportError(
      error instanceof Error?error.message:"Render manifest validation failed."
    );
  }
}

function manifestFingerprint(manifest:RenderManifest){
  return fingerprintJson(
    toJson(manifest) as unknown as Prisma.JsonValue
  );
}

async function renderMasterAsset(tx:Tx,projectId:string){
  return tx.asset.findFirst({
    where:{
      projectId,
      kind:AssetKind.RENDER_MASTER
    },
    orderBy:{createdAt:"asc"},
    include:{
      versions:{
        orderBy:{versionNumber:"desc"}
      }
    }
  });
}

export async function prepareRenderManifest(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const manifest=await compileCurrentManifest(tx,{
      projectId:input.projectId,
      projectVersionId:projectVersion.id
    });
    const fingerprint=manifestFingerprint(manifest);

    await saveManagedWizardStepInTransaction(tx,{
      projectVersionId:projectVersion.id,
      stepKey:"finish-export",
      payload:toJson({
        manifest,
        manifestFingerprint:fingerprint,
        preparedAt:new Date().toISOString()
      }),
      semanticFingerprint:fingerprint
    });

    return {manifest,manifestFingerprint:fingerprint};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function queueFinalMasterRender(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);

  const context=await db.$transaction(async tx=>{
    const current=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const manifest=await compileCurrentManifest(tx,{
      projectId:input.projectId,
      projectVersionId:projectVersion.id
    });
    const fingerprint=manifestFingerprint(manifest);
    if(current.step.payloadFingerprint!==fingerprint){
      throw new FinishExportError(
        "Prepare the current render manifest before rendering the final master."
      );
    }

    const active=await tx.generationJob.findFirst({
      where:{
        projectId:input.projectId,
        kind:GenerationKind.RENDER,
        providerKey:"ffmpeg:finish-export",
        status:{in:[GenerationStatus.QUEUED,GenerationStatus.RUNNING]}
      },
      select:{id:true}
    });
    if(active){
      throw new FinishExportError(
        "A final-master render job is already active."
      );
    }

    const project=await tx.project.findUniqueOrThrow({
      where:{id:input.projectId},
      select:{workspaceId:true}
    });
    const asset=await tx.asset.findFirst({
      where:{
        projectId:input.projectId,
        kind:AssetKind.RENDER_MASTER
      },
      orderBy:{createdAt:"asc"}
    });
    return {
      workspaceId:project.workspaceId,
      stepId:current.step.id,
      manifest,
      manifestFingerprint:fingerprint,
      renderAssetId:asset?.id??randomUUID()
    };
  });

  const job=await enqueueGenerationJob({
    workspaceId:context.workspaceId,
    projectId:input.projectId,
    kind:GenerationKind.RENDER,
    providerKey:"ffmpeg:finish-export",
    modelKey:"ffmpeg",
    requestSnapshot:toJson({
      schemaVersion:1,
      projectId:input.projectId,
      renderAssetId:context.renderAssetId,
      manifest:context.manifest,
      manifestFingerprint:context.manifestFingerprint
    }),
    requestedByUserId:input.userId,
    inputs:[
      {
        nodeId:context.manifest.sourceTimelineNodeId,
        role:"timeline",
        position:0
      },
      {
        nodeId:context.manifest.audioMasterNodeId,
        role:"audio-master",
        position:0
      },
      ...context.manifest.items.map(item=>({
        nodeId:item.clipNodeId,
        role:"video-clip",
        position:item.position
      }))
    ],
    prepare:async (tx,jobId)=>{
      // Claim this revision in the SAME transaction as the job and pg-boss row.
      // The earlier read/compile can race another tab, lock, or source edit.
      const claimed=await tx.wizardProgress.updateMany({
        where:{
          projectVersionId:projectVersion.id,
          revision:input.expectedWizardRevision
        },
        data:{revision:{increment:1}}
      });
      if(claimed.count!==1){
        throw new FinishExportConflictError(
          "Finish & Export changed in another request. Reload before continuing."
        );
      }
      const current=await mutationContext(tx,{
        ...input,
        projectVersionId:projectVersion.id,
        expectedWizardRevision:input.expectedWizardRevision+1
      });
      const manifest=await compileCurrentManifest(tx,{
        projectId:input.projectId,
        projectVersionId:projectVersion.id
      });
      if(manifestFingerprint(manifest)!==context.manifestFingerprint||
        current.step.payloadFingerprint!==context.manifestFingerprint){
        throw new FinishExportConflictError(
          "The render sources changed. Prepare the current manifest again."
        );
      }
      const active=await tx.generationJob.findFirst({
        where:{
          id:{not:jobId},
          projectId:input.projectId,
          kind:GenerationKind.RENDER,
          providerKey:"ffmpeg:finish-export",
          status:{in:[GenerationStatus.QUEUED,GenerationStatus.RUNNING]}
        },
        select:{id:true}
      });
      if(active) throw new FinishExportConflictError("A final-master render job is already active.");
      // Create the logical asset only after claiming the revision. A losing
      // concurrent request must not leave an earlier empty asset in history.
      await tx.asset.upsert({
        where:{id:context.renderAssetId},
        create:{
          id:context.renderAssetId,
          workspaceId:context.workspaceId,
          projectId:input.projectId,
          kind:AssetKind.RENDER_MASTER,
          name:"Master render"
        },
        update:{}
      });
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


export async function lockFinishExport(input:{
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
      throw new FinishExportError(
        "Render and verify the current final master before locking Finish & Export."
      );
    }

    const manifest=await compileCurrentManifest(tx,{
      projectId:input.projectId,
      projectVersionId:projectVersion.id
    });
    const fingerprint=manifestFingerprint(manifest);
    if(context.step.payloadFingerprint!==fingerprint){
      throw new FinishExportError(
        "Prepare and render the current manifest before locking Finish & Export."
      );
    }

    const active=await tx.generationJob.findFirst({
      where:{
        projectId:input.projectId,
        kind:GenerationKind.RENDER,
        providerKey:"ffmpeg:finish-export",
        status:{in:[GenerationStatus.QUEUED,GenerationStatus.RUNNING]}
      },
      select:{id:true}
    });
    if(active){
      throw new FinishExportError(
        "Wait for the active final-master render to finish before locking."
      );
    }

    const asset=await renderMasterAsset(tx,input.projectId);
    const master=asset?.versions.find(version=>
      version.status===AssetStatus.READY&&
      renderMetadata(version.metadata)?.manifestFingerprint===fingerprint
    )??null;
    if(!master||master.status!==AssetStatus.READY){
      throw new FinishExportError(
        "A verified final master for the current manifest is required before locking."
      );
    }

    const now=new Date();
    await tx.wizardStepState.update({
      where:{id:context.step.id},
      data:{lockedAt:now}
    });
    await tx.wizardProgress.update({
      where:{id:context.progress.id},
      data:{revision:{increment:1}}
    });

    return {
      renderMasterAssetVersionId:master.id,
      versionNumber:master.versionNumber,
      checksumSha256:master.checksumSha256
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getFinishExportState(input:{
  userId:string;
  projectId:string;
}){
  const projectVersion=await ensureWizardProgress(input);

  const snapshot=await db.$transaction(async tx=>{
    const progress=await tx.wizardProgress.findUniqueOrThrow({
      where:{projectVersionId:projectVersion.id},
      include:{steps:true}
    });
    const sourceStep=progress.steps.find(step=>step.stepKey==="refinement");
    const step=progress.steps.find(step=>step.stepKey==="finish-export");
    if(!step){
      throw new FinishExportError("Finish & Export wizard step is unavailable.");
    }

    let manifest:RenderManifest|null=null;
    let currentFingerprint:string|null=null;
    let sourceError:string|null=null;
    if(sourceStep?.lockedAt){
      try{
        manifest=await compileCurrentManifest(tx,{
          projectId:input.projectId,
          projectVersionId:projectVersion.id
        });
        currentFingerprint=manifestFingerprint(manifest);
      }catch(error){
        sourceError=error instanceof Error
          ?error.message
          :"Render manifest validation failed.";
      }
    }

    const prepared=Boolean(
      currentFingerprint&&
      step.payloadFingerprint===currentFingerprint
    );
    const recentJob=await tx.generationJob.findFirst({
      where:{
        projectId:input.projectId,
        kind:GenerationKind.RENDER,
        providerKey:"ffmpeg:finish-export"
      },
      orderBy:{createdAt:"desc"},
      select:{
        id:true,
        status:true,
        progressPercent:true,
        progressMessage:true,
        errorMessage:true,
        createdAt:true,
        completedAt:true
      }
    });
    const asset=await renderMasterAsset(tx,input.projectId);
    const currentMaster=currentFingerprint
      ?asset?.versions.find(version=>
        version.status===AssetStatus.READY&&
        renderMetadata(version.metadata)?.manifestFingerprint===
          currentFingerprint
      )??null
      :null;

    return {
      sourceReady:Boolean(sourceStep?.lockedAt&&manifest),
      sourceError,
      prepared,
      needsPrepare:Boolean(sourceStep?.lockedAt&&manifest&&!prepared),
      manifest,
      manifestFingerprint:currentFingerprint,
      recentJob,
      currentMaster,
      renderHistory:asset?.versions??[],
      wizardRevision:progress.revision,
      wizardStatus:step.status??WizardStepStatus.NOT_STARTED,
      wizardLocked:Boolean(step.lockedAt)
    };
  });

  const storage=createAssetStorage();
  return {
    sourceReady:snapshot.sourceReady,
    sourceError:snapshot.sourceError,
    prepared:snapshot.prepared,
    needsPrepare:snapshot.needsPrepare,
    manifest:snapshot.manifest,
    recentJob:snapshot.recentJob,
    currentMaster:snapshot.currentMaster
      ?{
        id:snapshot.currentMaster.id,
        versionNumber:snapshot.currentMaster.versionNumber,
        contentType:snapshot.currentMaster.contentType,
        byteSize:snapshot.currentMaster.byteSize?.toString()??null,
        checksumSha256:snapshot.currentMaster.checksumSha256,
        durationMs:snapshot.currentMaster.durationMs,
        frameRate:snapshot.currentMaster.frameRate,
        createdAt:snapshot.currentMaster.createdAt,
        readyAt:snapshot.currentMaster.readyAt,
        url:await storage.getSignedReadUrl(
          snapshot.currentMaster.storageKey,
          60*60
        ),
        downloadUrl:await storage.getSignedReadUrl(
          snapshot.currentMaster.storageKey,
          60*60,
          "music-video-master-v"+snapshot.currentMaster.versionNumber+".mp4"
        )
      }
      :null,
    renderHistory:await Promise.all(snapshot.renderHistory.map(async version=>({
      id:version.id,
      versionNumber:version.versionNumber,
      status:version.status,
      contentType:version.contentType,
      byteSize:version.byteSize?.toString()??null,
      checksumSha256:version.checksumSha256,
      durationMs:version.durationMs,
      frameRate:version.frameRate,
      createdAt:version.createdAt,
      readyAt:version.readyAt,
      downloadUrl:version.status===AssetStatus.READY
        ?await storage.getSignedReadUrl(version.storageKey,60*60,
          "music-video-master-v"+version.versionNumber+".mp4")
        :null,
      current:Boolean(
        snapshot.currentMaster&&
        version.id===snapshot.currentMaster.id
      )
    }))),
    wizardRevision:snapshot.wizardRevision,
    wizardStatus:snapshot.wizardStatus,
    wizardLocked:snapshot.wizardLocked
  };
}
