import { createHash,randomUUID } from "node:crypto";
import { readFile,unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationJob } from "@prisma/client";
import {
  AssetKind,
  AssetStatus,
  DependencyRelation,
  DomainVersionKind,
  Prisma,
  VersionLifecycle
} from "@prisma/client";
import { db } from "@/lib/db";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { getEnvironment } from "@/lib/env";
import type { GenerationHandlerContext } from "@/lib/jobs/registry";
import { PermanentGenerationError } from "@/lib/jobs/registry";
import { MediaProviderError } from "@/lib/media-generation/errors";
import { getConfiguredMediaGenerationAdapters } from "@/lib/media-generation/factory";
import { modelRejectionReasons } from "@/lib/media-generation/selection";
import type {
  MediaGenerationAdapter,
  MediaGenerationOutput,
  MediaGenerationResult,
  MediaGenerationReference,
  MediaModelDescriptor
} from "@/lib/media-generation/types";
import { shotSpecificationSpecSchema } from "@/lib/shot-specifications/schema";
import { createAssetStorage,type AssetStorage } from "@/lib/storage";
import { verifyGeneratedClip } from "./verification";
import { queuedVideoClipGenerationSchema } from "./input";
import { completeVideoClipsIfCovered,VideoClipsError } from "./service";
import {
  parseVideoClipMetadata,
  videoClipAssetsForProject
} from "./source";

function sleep(ms:number,signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(resolve,ms);
    signal.addEventListener("abort",()=>{
      clearTimeout(timer);
      reject(signal.reason??new Error("Generation aborted."));
    },{once:true});
  });
}

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function resumeTaskId(value:unknown):string|null{
  if(!value||typeof value!=="object"||Array.isArray(value)) return null;
  const id=(value as Record<string,unknown>).providerTaskId;
  return typeof id==="string"&&id?id:null;
}

async function firstFrameReference(
  storage:AssetStorage,
  input:{storageKey:string;contentType:string}
):Promise<MediaGenerationReference>{
  const signed=await storage.getSignedReadUrl(input.storageKey,60*30);
  if(signed.startsWith("https://")){
    return {
      role:"FIRST_FRAME",
      contentType:input.contentType,
      url:signed
    };
  }

  const path=join(tmpdir(),"music-video-wizard-frame-"+randomUUID());
  try{
    await storage.downloadToFile(input.storageKey,path);
    const bytes=await readFile(path);
    const dataUri=
      "data:"+input.contentType+";base64,"+bytes.toString("base64");
    if(dataUri.length>5*1024*1024){
      throw new PermanentGenerationError(
        "The Initial Frame is too large for the inline first-frame limit. "+
        "Use HTTPS-backed asset storage or a smaller frame asset."
      );
    }
    return {
      role:"FIRST_FRAME",
      contentType:input.contentType,
      dataUri
    };
  }finally{
    await unlink(path).catch(()=>undefined);
  }
}

async function outputBytes(output:MediaGenerationOutput){
  if(output.kind==="INLINE_BASE64"&&output.base64){
    return new Uint8Array(Buffer.from(output.base64,"base64"));
  }
  if(output.kind==="REMOTE_URL"&&output.url){
    const response=await fetch(output.url);
    if(!response.ok){
      throw new Error(
        "Generated video download returned HTTP "+response.status+"."
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new PermanentGenerationError(
    "Video provider returned an unusable generation output."
  );
}

async function execute(
  job:GenerationJob,
  adapter:MediaGenerationAdapter,
  model:MediaModelDescriptor,
  request:ReturnType<typeof queuedVideoClipGenerationSchema.parse>["request"],
  reference:MediaGenerationReference,
  context:GenerationHandlerContext
):Promise<MediaGenerationResult>{
  const reasons=modelRejectionReasons(model,request);
  if(reasons.length){
    throw new PermanentGenerationError(
      "Selected video model no longer satisfies the compiled request: "+
      reasons.join(", ")
    );
  }

  let taskId=resumeTaskId(job.responseMetadata);
  if(!taskId){
    const submission=await adapter.submit({
      model,
      request,
      references:[reference]
    });
    if(submission.immediateResult) return submission.immediateResult;
    if(!submission.externalJobId){
      throw new PermanentGenerationError(
        "Video provider returned neither an immediate result nor a task ID."
      );
    }
    taskId=submission.externalJobId;
    await db.generationJob.update({
      where:{id:job.id},
      data:{
        responseMetadata:toJson({
          providerTaskId:taskId,
          providerId:adapter.providerId,
          modelId:model.modelId,
          providerRequestSnapshot:submission.requestSnapshot
        })
      }
    });
  }

  let progress=20;
  while(true){
    if(context.signal.aborted){
      if(adapter.cancel){
        await adapter.cancel({
          model,
          externalJobId:taskId
        }).catch(()=>undefined);
      }
      throw context.signal.reason??new Error("Generation aborted.");
    }
    const result=await adapter.poll({
      model,
      externalJobId:taskId
    });
    if(
      result.status==="SUCCEEDED"||
      result.status==="FAILED"||
      result.status==="CANCELED"
    ) return result;
    progress=Math.min(80,progress+5);
    await context.reportProgress(progress,"Waiting for video provider.");
    await sleep(5000,context.signal);
  }
}

async function existingOutput(jobId:string){
  const output=await db.generationOutput.findFirst({
    where:{jobId,role:"video-clip"}
  });
  if(!output) return null;
  const version=await db.assetVersion.findFirst({
    where:{nodeId:output.nodeId}
  });
  return version?{
    assetVersionId:version.id,
    nodeId:version.nodeId,
    reused:true
  }:null;
}

export async function handleVideoClipGeneration(
  job:GenerationJob,
  context:GenerationHandlerContext
){
  const queued=queuedVideoClipGenerationSchema.parse(job.requestSnapshot);
  const already=await existingOutput(job.id);
  if(already) return already;
  if(!job.modelKey){
    throw new PermanentGenerationError(
      "Video Clip job is missing its selected model snapshot."
    );
  }

  const source=await db.shotVersion.findFirst({
    where:{
      id:queued.shotSpecificationVersionId,
      nodeId:queued.shotSpecificationNodeId,
      lifecycle:VersionLifecycle.LOCKED,
      shot:{projectId:queued.projectId}
    }
  });
  if(!source){
    throw new PermanentGenerationError(
      "The locked Shot Specification source no longer exists."
    );
  }
  const specification=shotSpecificationSpecSchema.parse(source.structuredSpec);
  if(
    specification.sourceStoryboardShotVersionId!==
      queued.sourceStoryboardShotVersionId
  ){
    throw new PermanentGenerationError(
      "Video Clip source provenance no longer matches the queued request."
    );
  }

  const frame=await db.assetVersion.findFirst({
    where:{
      id:queued.initialFrameAssetVersionId,
      nodeId:queued.initialFrameNodeId,
      status:AssetStatus.READY,
      asset:{
        projectId:queued.projectId,
        kind:AssetKind.GENERATED_IMAGE
      }
    }
  });
  if(!frame){
    throw new PermanentGenerationError(
      "The approved Initial Frame source no longer exists."
    );
  }

  const providerId=job.providerKey.replace(/:video-clip$/,"");
  const adapters=getConfiguredMediaGenerationAdapters(getEnvironment());
  const adapter=adapters.find(candidate=>candidate.providerId===providerId);
  if(!adapter){
    throw new PermanentGenerationError(
      "Configured video provider is unavailable: "+providerId
    );
  }
  const model=(await adapter.listModels()).find(
    candidate=>candidate.modelId===job.modelKey
  );
  if(!model){
    throw new PermanentGenerationError(
      "Configured video model is unavailable: "+job.modelKey
    );
  }

  const storage=createAssetStorage();
  const reference=await firstFrameReference(storage,{
    storageKey:frame.storageKey,
    contentType:frame.contentType
  });

  await context.reportProgress(15,"Generating video clip.");
  let result:MediaGenerationResult;
  try{
    result=await execute(
      job,adapter,model,queued.request,reference,context
    );
  }catch(error){
    if(error instanceof MediaProviderError&&error.permanent){
      throw new PermanentGenerationError(error.message);
    }
    throw error;
  }
  if(result.status!=="SUCCEEDED"){
    throw new PermanentGenerationError(
      result.errorMessage??"Video provider did not produce a successful clip."
    );
  }
  const output=result.outputs[0];
  if(!output){
    throw new PermanentGenerationError("Video provider returned no clip output.");
  }

  await context.reportProgress(85,"Copying generated clip into project storage.");
  const bytes=await outputBytes(output);
  if(!bytes.byteLength){
    throw new PermanentGenerationError("Generated Video Clip is empty.");
  }
  const checksum=createHash("sha256").update(bytes).digest("hex");
  const env = getEnvironment();
  const verified = await verifyGeneratedClip({ bytes, minimumDurationMs: queued.request.generationDurationMs,
    maxBytes: env.MAX_MEDIA_UPLOAD_BYTES, ffmpeg: env.VIDEO_RENDER_FFMPEG, ffprobe: env.VIDEO_RENDER_FFPROBE, signal: context.signal });
  const generatedDurationMs = verified.durationMs!;

  const assets=await db.$transaction(tx=>
    videoClipAssetsForProject(tx,queued.projectId)
  );
  const priorAsset=assets.find(asset=>
    asset.versions.some(version=>
      parseVideoClipMetadata(version.metadata)?.logicalShotId===source.shotId
    )
  )??null;
  const assetId=priorAsset?.id??randomUUID();
  const assetVersionId=job.id;
  const nodeId=randomUUID();
  const versionNumber=(priorAsset?.versions[0]?.versionNumber??0)+1;
  const contentType=verified.contentType;
  const extension=contentType==="video/webm"?"webm":"mp4";
  const storageKey=[
    "workspaces",job.workspaceId,
    "projects",queued.projectId,
    "video-clips",assetId,
    assetVersionId+"."+extension
  ].join("/");

  await storage.put({
    key:storageKey,
    body:bytes,
    contentType
  });

  try{
    const persisted=await db.$transaction(async tx=>{
      const duplicate=await tx.generationOutput.findFirst({
        where:{jobId:job.id,role:"video-clip"}
      });
      if(duplicate){
        const version=await tx.assetVersion.findFirstOrThrow({
          where:{nodeId:duplicate.nodeId}
        });
        return {assetVersionId:version.id,nodeId:version.nodeId,reused:true};
      }

      const currentSource=await tx.shotVersion.findFirst({
        where:{
          id:queued.shotSpecificationVersionId,
          nodeId:queued.shotSpecificationNodeId,
          lifecycle:VersionLifecycle.LOCKED,
          shot:{projectId:queued.projectId}
        }
      });
      const currentFrame=await tx.assetVersion.findFirst({
        where:{
          id:queued.initialFrameAssetVersionId,
          nodeId:queued.initialFrameNodeId,
          status:AssetStatus.READY
        }
      });
      if(!currentSource||!currentFrame){
        throw new VideoClipsError(
          "Video Clip sources changed before the generated clip could be persisted."
        );
      }

      await tx.domainVersionNode.create({
        data:{
          id:nodeId,
          kind:DomainVersionKind.ASSET,
          fingerprint:checksum
        }
      });
      if(!priorAsset){
        await tx.asset.create({
          data:{
            id:assetId,
            workspaceId:job.workspaceId,
            projectId:queued.projectId,
            kind:AssetKind.GENERATED_VIDEO,
            name:"Video clip · "+(currentSource.label??"shot")
          }
        });
      }
      await tx.assetVersion.create({
        data:{
          id:assetVersionId,
          assetId,
          nodeId,
          versionNumber,
          status:AssetStatus.READY,
          storageKey,
          contentType,
          byteSize:BigInt(bytes.byteLength),
          checksumSha256:checksum,
          durationMs:generatedDurationMs,
          frameRate:verified.frameRate,
          width:verified.width,
          height:verified.height,
          metadata:{
            role:"video-clip",
            logicalShotId:currentSource.shotId,
            sourceShotSpecificationVersionId:currentSource.id,
            sourceInitialFrameAssetVersionId:currentFrame.id,
            sourceStoryboardShotVersionId:
              specification.sourceStoryboardShotVersionId,
            generationJobId:job.id,
            providerId,
            modelId:job.modelKey,
            editorialDurationMs:queued.request.editorialDurationMs,
            generatedDurationMs
          },
          createdByUserId:job.requestedByUserId,
          readyAt:new Date()
        }
      });
      await registerDependencyEdgeInTransaction(tx,{
        upstreamNodeId:currentSource.nodeId,
        downstreamNodeId:nodeId,
        relation:DependencyRelation.GENERATED_FROM,
        reason:
          "Video Clip is generated from this exact locked Shot Specification."
      });
      await registerDependencyEdgeInTransaction(tx,{
        upstreamNodeId:currentFrame.nodeId,
        downstreamNodeId:nodeId,
        relation:DependencyRelation.GENERATED_FROM,
        reason:
          "Video Clip starts from this exact locked Initial Frame AssetVersion."
      });
      await tx.generationOutput.create({
        data:{
          jobId:job.id,
          nodeId,
          role:"video-clip",
          position:0
        }
      });
      await completeVideoClipsIfCovered(tx,{
        projectId:queued.projectId,
        projectVersionId:queued.projectVersionId
      });
      return {assetVersionId,nodeId,reused:false};
    });

    return {
      ...persisted,
      checksumSha256:checksum,
      providerId,
      modelId:job.modelKey,
      providerTaskId:result.externalJobId,
      providerSnapshot:result.providerSnapshot??null
    };
  }catch(error){
    await storage.delete(storageKey).catch(()=>undefined);
    if(error instanceof VideoClipsError){
      throw new PermanentGenerationError(error.message);
    }
    throw error;
  }
}
