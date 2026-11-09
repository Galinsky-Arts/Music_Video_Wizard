import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationJob } from "@prisma/client";
import {
  AssetKind,
  AssetStatus,
  DependencyRelation,
  DomainVersionKind,
  Prisma,
  TimelineKind,
  VersionLifecycle
} from "@prisma/client";
import { db } from "@/lib/db";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { getEnvironment } from "@/lib/env";
import {
  PermanentGenerationError,
  type GenerationHandlerContext
} from "@/lib/jobs/registry";
import { createAssetStorage } from "@/lib/storage";
import {
  completeAutomaticWizardStepInTransaction
} from "@/lib/wizard/service";
import { buildFfmpegRenderCommand } from "./ffmpeg";
import { runMediaProcess } from "@/lib/media/process";
import { verifyRenderedMaster, type VerifiedMaster } from "./verification";
import { queuedMasterRenderSchema } from "./input";

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function extensionFor(contentType:string){
  switch(contentType){
    case "video/webm": return "webm";
    case "audio/mpeg": return "mp3";
    case "audio/wav":
    case "audio/x-wav": return "wav";
    case "audio/flac": return "flac";
    case "audio/ogg": return "ogg";
    case "audio/aac": return "aac";
    case "audio/mp4": return "m4a";
    default: return "bin";
  }
}

async function sha256File(path:string){
  const hash=createHash("sha256");
  await new Promise<void>((resolve,reject)=>{
    const stream=createReadStream(path);
    stream.on("data",chunk=>hash.update(chunk));
    stream.once("error",reject);
    stream.once("end",resolve);
  });
  return hash.digest("hex");
}

async function existingOutput(jobId:string){
  const output=await db.generationOutput.findFirst({
    where:{jobId,role:"render-master"}
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

export async function handleFinalMasterRender(
  job:GenerationJob,
  context:GenerationHandlerContext
){
  const queued=queuedMasterRenderSchema.parse(job.requestSnapshot);
  const already=await existingOutput(job.id);
  if(already) return already;

  const sourceTimeline=await db.timelineVersion.findFirst({
    where:{
      id:queued.manifest.sourceTimelineVersionId,
      nodeId:queued.manifest.sourceTimelineNodeId,
      lifecycle:VersionLifecycle.LOCKED,
      basisProjectVersionId:queued.manifest.projectVersionId,
      timeline:{
        projectId:queued.projectId,
        kind:TimelineKind.WORKING
      }
    }
  });
  if(!sourceTimeline){
    throw new PermanentGenerationError(
      "Locked Refinement timeline no longer matches the queued render manifest."
    );
  }

  const audio=await db.assetVersion.findFirst({
    where:{
      id:queued.manifest.audioMasterAssetVersionId,
      nodeId:queued.manifest.audioMasterNodeId,
      status:AssetStatus.READY,
      asset:{
        projectId:queued.projectId,
        kind:AssetKind.AUDIO_MASTER
      }
    }
  });
  if(!audio){
    throw new PermanentGenerationError(
      "Immutable audio master no longer matches the queued render manifest."
    );
  }

  const clipIds=queued.manifest.items.map(
    item=>item.clipAssetVersionId
  );
  const clips=await db.assetVersion.findMany({
    where:{
      id:{in:clipIds},
      status:AssetStatus.READY,
      asset:{
        projectId:queued.projectId,
        kind:AssetKind.GENERATED_VIDEO
      }
    }
  });
  const clipById=new Map(clips.map(clip=>[clip.id,clip]));
  for(const item of queued.manifest.items){
    const clip=clipById.get(item.clipAssetVersionId);
    if(!clip||clip.nodeId!==item.clipNodeId){
      throw new PermanentGenerationError(
        "A Video Clip no longer matches the queued render manifest."
      );
    }
  }

  const renderAsset=await db.asset.findFirst({
    where:{
      id:queued.renderAssetId,
      projectId:queued.projectId,
      kind:AssetKind.RENDER_MASTER
    },
    include:{
      versions:{orderBy:{versionNumber:"desc"}}
    }
  });
  if(!renderAsset){
    throw new PermanentGenerationError(
      "Logical master-render asset no longer exists."
    );
  }

  const storage=createAssetStorage();
  const workspace=await mkdtemp(
    join(tmpdir(),"music-video-wizard-render-")
  );

  try{
    await context.reportProgress(10,"Materializing locked render sources.");
    const clipPaths:string[]=[];
    for(const item of queued.manifest.items){
      const clip=clipById.get(item.clipAssetVersionId)!;
      const path=join(
        workspace,
        "clip-"+String(item.position)+"."+extensionFor(clip.contentType)
      );
      await storage.downloadToFile(clip.storageKey,path);
      clipPaths.push(path);
    }
    const audioPath=join(
      workspace,
      "audio."+extensionFor(audio.contentType)
    );
    await storage.downloadToFile(audio.storageKey,audioPath);

    const outputPath=join(workspace,"master.mp4");
    const env=getEnvironment();
    const command=buildFfmpegRenderCommand({
      executable:env.VIDEO_RENDER_FFMPEG,
      manifest:queued.manifest,
      clipPaths,
      audioPath,
      outputPath
    });

    await context.reportProgress(35,"Rendering final master with FFmpeg.");
    try{
      await runMediaProcess({
        executable:command.executable,
        args:command.args,
        signal:context.signal,
        description:"FFmpeg master render"
      });
    }catch(error){
      if(context.signal.aborted) throw error;
      throw new PermanentGenerationError(
        error instanceof Error?error.message:"FFmpeg master render failed."
      );
    }

    await context.reportProgress(82,"Verifying rendered master.");
    let verified: VerifiedMaster;
    try{
      verified = await verifyRenderedMaster({
        ffmpeg: env.VIDEO_RENDER_FFMPEG,
        ffprobe: env.VIDEO_RENDER_FFPROBE,
        path: outputPath,
        manifest: queued.manifest,
        signal: context.signal
      });
    }catch(error){
      if(context.signal.aborted) throw error;
      throw new PermanentGenerationError(
        error instanceof Error?error.message:"Rendered master verification failed."
      );
    }

    const info=await stat(outputPath);
    if(info.size<=0){
      throw new PermanentGenerationError(
        "Rendered master file is empty."
      );
    }
    const checksumSha256=await sha256File(outputPath);

    const assetVersionId=job.id;
    const nodeId=randomUUID();
    const versionNumber=(renderAsset.versions[0]?.versionNumber??0)+1;
    const storageKey=[
      "workspaces",job.workspaceId,
      "projects",queued.projectId,
      "renders",queued.renderAssetId,
      // A recovered/late attempt must never overwrite another attempt's output.
      assetVersionId+"-"+randomUUID()+".mp4"
    ].join("/");

    await context.reportProgress(90,"Persisting rendered master.");
    await storage.putFile({
      key:storageKey,
      filePath:outputPath,
      contentType:"video/mp4"
    });

    try{
      context.signal.throwIfAborted();
      const persisted=await db.$transaction(async tx=>{
        const duplicate=await tx.generationOutput.findFirst({
          where:{jobId:job.id,role:"render-master"}
        });
        if(duplicate){
          const version=await tx.assetVersion.findFirstOrThrow({
            where:{nodeId:duplicate.nodeId}
          });
          return {
            assetVersionId:version.id,
            nodeId:version.nodeId,
            reused:true
          };
        }

        const currentTimeline=await tx.timelineVersion.findFirst({
          where:{
            id:queued.manifest.sourceTimelineVersionId,
            nodeId:queued.manifest.sourceTimelineNodeId,
            lifecycle:VersionLifecycle.LOCKED,
            basisProjectVersionId:queued.manifest.projectVersionId,
            timeline:{projectId:queued.projectId,kind:TimelineKind.WORKING}
          }
        });
        if(!currentTimeline){
          throw new PermanentGenerationError(
            "Locked Refinement timeline changed before render persistence."
          );
        }

        await tx.domainVersionNode.create({
          data:{
            id:nodeId,
            kind:DomainVersionKind.ASSET,
            fingerprint:checksumSha256
          }
        });
        await tx.assetVersion.create({
          data:{
            id:assetVersionId,
            assetId:queued.renderAssetId,
            nodeId,
            versionNumber,
            status:AssetStatus.READY,
            storageKey,
            contentType:"video/mp4",
            byteSize:BigInt(info.size),
            checksumSha256,
            width:verified.width,
            height:verified.height,
            durationMs:verified.durationMs,
            frameRate:verified.frameRate,
            metadata:toJson({
              role:"render-master",
              manifestFingerprint:queued.manifestFingerprint,
              sourceTimelineVersionId:
                queued.manifest.sourceTimelineVersionId,
              sourceTimelineNodeId:
                queued.manifest.sourceTimelineNodeId,
              audioMasterAssetVersionId:
                queued.manifest.audioMasterAssetVersionId,
              projectVersionId:queued.manifest.projectVersionId,
              generationJobId:job.id,
              renderer:"ffmpeg",
              verification:toJson(verified),
              output:queued.manifest.output,
              expectedFrameCount:
                queued.manifest.expectedFrameCount
            }),
            createdByUserId:job.requestedByUserId,
            readyAt:new Date()
          }
        });

        const upstreamNodes=new Set<string>([
          queued.manifest.sourceTimelineNodeId,
          queued.manifest.audioMasterNodeId,
          ...queued.manifest.items.map(item=>item.clipNodeId)
        ]);
        for(const upstreamNodeId of upstreamNodes){
          await registerDependencyEdgeInTransaction(tx,{
            upstreamNodeId,
            downstreamNodeId:nodeId,
            relation:DependencyRelation.RENDERED_FROM,
            reason:
              "Final master render contains this exact locked source version."
          });
        }

        await tx.generationOutput.create({
          data:{
            jobId:job.id,
            nodeId,
            role:"render-master",
            position:0
          }
        });

        await completeAutomaticWizardStepInTransaction(tx,{
          projectVersionId:queued.manifest.projectVersionId,
          stepKey:"finish-export",
          payload:toJson({
            manifest:queued.manifest,
            manifestFingerprint:queued.manifestFingerprint,
            renderMasterAssetId:queued.renderAssetId,
            renderMasterAssetVersionId:assetVersionId,
            renderMasterNodeId:nodeId,
            checksumSha256,
            renderedAt:new Date().toISOString()
          }),
          semanticFingerprint:queued.manifestFingerprint
        });

        return {assetVersionId,nodeId,reused:false};
      });

      if(persisted.reused){
        await storage.delete(storageKey);
        return persisted;
      }
      return {
        ...persisted,
        checksumSha256,
        byteSize:info.size,
        manifestFingerprint:queued.manifestFingerprint
      };
    }catch(error){
      await storage.delete(storageKey).catch(()=>undefined);
      throw error;
    }
  }finally{
    await rm(workspace,{recursive:true,force:true}).catch(()=>undefined);
  }
}
