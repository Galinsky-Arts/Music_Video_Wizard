import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AssetKind, AssetStatus, DependencyRelation, DomainVersionKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { createAssetStorage } from "@/lib/storage";
import { ensurePersonalWorkspace } from "@/lib/workspaces";
import {
  checksumsSchema,
  extensionForContentType,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_ENTRIES,
  mediaEntryName,
  PACKAGE_FORMAT,
  PACKAGE_SCHEMA_VERSION,
  projectPackageManifestSchema,
  type ProjectPackageManifest
} from "./manifest";
import { extractTar, tarEnd, tarHeader, tarPadding } from "./tar";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class ProjectPackageError extends Error{}

const RESTORABLE_CONTENT_TYPE = /^(audio\/[a-z0-9.+-]+|image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm))$/;

interface PackageMedia{
  entryName:string;
  storageKey:string;
}

export interface PreparedProjectPackage{
  manifest:ProjectPackageManifest;
  media:PackageMedia[];
  fileName:string;
}

function safeFileName(title:string){
  const base=title.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80);
  return (base||"project")+".mvwpkg.tar";
}

/** Snapshot of the latest project version, its wizard state and every READY asset. */
export async function prepareProjectPackage(input:{userId:string;projectId:string}):Promise<PreparedProjectPackage>{
  const project=await db.project.findFirst({
    where:{id:input.projectId,...projectEditorWhere(input.userId)},
    include:{
      versions:{
        orderBy:{versionNumber:"desc"},
        take:1,
        include:{wizardProgress:{include:{steps:{orderBy:{ordinal:"asc"}}}}}
      }
    }
  });
  const version=project?.versions[0];
  if(!project||!version) throw new ProjectPackageError("Project not found.");

  const assets=await db.asset.findMany({
    where:{projectId:project.id},
    orderBy:{createdAt:"asc"},
    include:{versions:{orderBy:{versionNumber:"asc"}}}
  });
  const storage=createAssetStorage();
  const media:PackageMedia[]=[];
  const missingMedia:ProjectPackageManifest["missingMedia"]=[];
  const packageAssets:ProjectPackageManifest["assets"]=[];
  for(const asset of assets){
    const versions:ProjectPackageManifest["assets"][number]["versions"]=[];
    for(const assetVersion of asset.versions){
      let path:string|null=null;
      if(assetVersion.status!==AssetStatus.READY){
        missingMedia.push({assetVersionId:assetVersion.id,reason:"Asset version is "+assetVersion.status.toLowerCase()+", not ready."});
      }else if(!await storage.exists(assetVersion.storageKey).catch(()=>false)){
        missingMedia.push({assetVersionId:assetVersion.id,reason:"Media object is missing from storage."});
      }else{
        path=mediaEntryName(assetVersion.id,assetVersion.contentType);
        media.push({entryName:path,storageKey:assetVersion.storageKey});
      }
      versions.push({
        assetVersionId:assetVersion.id,
        versionNumber:assetVersion.versionNumber,
        contentType:assetVersion.contentType,
        byteSize:assetVersion.byteSize===null?null:Number(assetVersion.byteSize),
        checksumSha256:assetVersion.checksumSha256&&/^[a-f0-9]{64}$/.test(assetVersion.checksumSha256)?assetVersion.checksumSha256:null,
        width:assetVersion.width,
        height:assetVersion.height,
        durationMs:assetVersion.durationMs,
        frameRate:assetVersion.frameRate,
        metadata:assetVersion.metadata??null,
        createdAt:assetVersion.createdAt.toISOString(),
        path
      });
    }
    packageAssets.push({assetId:asset.id,kind:asset.kind,name:asset.name,versions});
  }
  if(media.length+2>MAX_PACKAGE_ENTRIES){
    throw new ProjectPackageError("Project has too many media files to package.");
  }

  const manifest:ProjectPackageManifest={
    format:PACKAGE_FORMAT,
    schemaVersion:PACKAGE_SCHEMA_VERSION,
    exportedAt:new Date().toISOString(),
    source:{projectId:project.id,projectVersionId:version.id},
    project:{title:project.title,description:project.description},
    projectVersion:{
      versionNumber:version.versionNumber,
      aspectRatio:version.aspectRatio,
      outputWidth:version.outputWidth,
      outputHeight:version.outputHeight,
      frameRate:version.frameRate,
      audioMasterAssetVersionId:version.audioMasterAssetVersionId
    },
    wizard:{
      currentStepKey:version.wizardProgress?.currentStepKey??null,
      steps:(version.wizardProgress?.steps??[]).map(step=>({
        stepKey:step.stepKey,
        status:step.status,
        payload:step.payload??null
      }))
    },
    assets:packageAssets,
    missingMedia
  };
  projectPackageManifestSchema.parse(manifest);
  return {manifest,media,fileName:safeFileName(project.title)};
}

/**
 * Streams manifest.json, each media file (staged one at a time on disk), then
 * checksums.json. Media that disappears mid-export is simply absent; restore
 * reports it as missing.
 */
export function projectPackageStream(prepared:PreparedProjectPackage):Readable{
  const storage=createAssetStorage();
  async function* generate(){
    const directory=await mkdtemp(join(tmpdir(),"mvw-package-"));
    try{
      const manifestBytes=Buffer.from(JSON.stringify(prepared.manifest,null,2)+"\n","utf8");
      const now=Date.now()/1000;
      yield tarHeader("manifest.json",manifestBytes.length,now);
      yield manifestBytes;
      yield tarPadding(manifestBytes.length);
      const checksums:Record<string,string>={};
      for(const [index,item] of prepared.media.entries()){
        const staged=join(directory,"media-"+String(index));
        try{
          await storage.downloadToFile(item.storageKey,staged);
        }catch{
          continue;
        }
        const {size}=await stat(staged);
        const hash=createHash("sha256");
        yield tarHeader(item.entryName,size,now);
        for await (const chunk of createReadStream(staged)){
          hash.update(chunk as Buffer);
          yield chunk as Buffer;
        }
        yield tarPadding(size);
        checksums[item.entryName]=hash.digest("hex");
        await rm(staged,{force:true});
      }
      const checksumBytes=Buffer.from(JSON.stringify(checksums,null,2)+"\n","utf8");
      yield tarHeader("checksums.json",checksumBytes.length,now);
      yield checksumBytes;
      yield tarPadding(checksumBytes.length);
      yield tarEnd();
    }finally{
      await rm(directory,{recursive:true,force:true});
    }
  }
  return Readable.from(generate(),{objectMode:false});
}

async function sha256File(path:string){
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface RestoreReport{
  projectId:string;
  projectVersionId:string;
  restoredMedia:number;
  audioMasterRestored:boolean;
  missingMedia:Array<{assetVersionId:string;reason:string}>;
  notRestored:string[];
}

/**
 * Restores a package as a NEW project in the caller's workspace: project
 * settings, the audio master and every included media version (checksums
 * verified). Missing or corrupt media is reported, never invented. Planning
 * steps reference IDs of the source project, so they are reported rather than
 * rehydrated; the restored project starts its wizard from Project setup.
 */
export async function restoreProjectPackage(input:{
  userId:string;
  displayName:string;
  body:Readable;
}):Promise<RestoreReport>{
  const directory=await mkdtemp(join(tmpdir(),"mvw-restore-"));
  const uploadedKeys:string[]=[];
  const storage=createAssetStorage();
  try{
    let entries;
    try{
      entries=await extractTar(input.body,{
        directory,
        maxEntries:MAX_PACKAGE_ENTRIES,
        maxTotalBytes:MAX_PACKAGE_BYTES,
        maxEntryBytes:MAX_PACKAGE_BYTES
      });
    }catch(error){
      throw new ProjectPackageError(error instanceof Error?error.message:"Package could not be read.");
    }
    const byName=new Map(entries.map(entry=>[entry.name,entry]));
    const manifestEntry=byName.get("manifest.json");
    if(!manifestEntry||manifestEntry.size>10*1024*1024){
      throw new ProjectPackageError("Package is missing a valid manifest.json.");
    }
    let manifest:ProjectPackageManifest;
    let checksums:Record<string,string>={};
    try{
      manifest=projectPackageManifestSchema.parse(JSON.parse(await readFile(manifestEntry.path,"utf8")));
      const checksumEntry=byName.get("checksums.json");
      if(checksumEntry&&checksumEntry.size<=10*1024*1024){
        checksums=checksumsSchema.parse(JSON.parse(await readFile(checksumEntry.path,"utf8")));
      }
    }catch{
      throw new ProjectPackageError("Package manifest is not a valid Music Video Wizard project package.");
    }

    const workspace=await ensurePersonalWorkspace(input.userId,input.displayName);
    const projectId=randomUUID();
    const missingMedia=[...manifest.missingMedia];
    type Staged={assetVersionId:string;newVersionId:string;nodeId:string;storageKey:string;checksum:string;size:number};
    const staged=new Map<string,Staged>();
    for(const asset of manifest.assets){
      for(const version of asset.versions){
        if(!version.path) continue;
        const entry=byName.get(version.path);
        if(!entry||version.path!==mediaEntryName(version.assetVersionId,version.contentType)){
          missingMedia.push({assetVersionId:version.assetVersionId,reason:"Media file is not present in the package."});
          continue;
        }
        if(!RESTORABLE_CONTENT_TYPE.test(version.contentType)){
          missingMedia.push({assetVersionId:version.assetVersionId,reason:"Unsupported media type "+version.contentType+"."});
          continue;
        }
        const checksum=await sha256File(entry.path);
        const expected=[version.checksumSha256,checksums[version.path]].filter((value):value is string=>Boolean(value));
        if(expected.some(value=>value!==checksum)){
          missingMedia.push({assetVersionId:version.assetVersionId,reason:"Media checksum does not match the manifest."});
          continue;
        }
        const newVersionId=randomUUID();
        const storageKey=["workspaces",workspace.id,"projects",projectId,"restored",newVersionId+"."+extensionForContentType(version.contentType)].join("/");
        await storage.putFile({key:storageKey,filePath:entry.path,contentType:version.contentType});
        uploadedKeys.push(storageKey);
        staged.set(version.assetVersionId,{assetVersionId:version.assetVersionId,newVersionId,nodeId:randomUUID(),storageKey,checksum,size:entry.size});
      }
    }

    const sourceAudio=manifest.projectVersion.audioMasterAssetVersionId;
    const audio=sourceAudio?staged.get(sourceAudio):undefined;
    const projectVersionId=randomUUID();
    const projectNodeId=randomUUID();
    await db.$transaction(async tx=>{
      await tx.project.create({data:{
        id:projectId,
        workspaceId:workspace.id,
        title:manifest.project.title,
        description:manifest.project.description
      }});
      for(const asset of manifest.assets){
        const versions=asset.versions.filter(version=>staged.has(version.assetVersionId));
        if(!versions.length) continue;
        const assetId=randomUUID();
        await tx.asset.create({data:{id:assetId,workspaceId:workspace.id,projectId,kind:asset.kind as AssetKind,name:asset.name}});
        for(const version of versions){
          const item=staged.get(version.assetVersionId)!;
          await tx.domainVersionNode.create({data:{id:item.nodeId,kind:DomainVersionKind.ASSET,fingerprint:item.checksum}});
          await tx.assetVersion.create({data:{
            id:item.newVersionId,
            assetId,
            nodeId:item.nodeId,
            versionNumber:version.versionNumber,
            status:AssetStatus.READY,
            storageKey:item.storageKey,
            contentType:version.contentType,
            byteSize:BigInt(item.size),
            checksumSha256:item.checksum,
            width:version.width,
            height:version.height,
            durationMs:version.durationMs,
            frameRate:version.frameRate,
            // Source provenance is nested so no live service mistakes it for
            // links into this project's (not yet rebuilt) plan.
            metadata:JSON.parse(JSON.stringify({
              restoredFrom:{
                projectId:manifest.source.projectId,
                assetVersionId:version.assetVersionId,
                exportedAt:manifest.exportedAt,
                originalMetadata:version.metadata??null
              }
            })) as Prisma.InputJsonValue,
            createdByUserId:input.userId,
            readyAt:new Date()
          }});
        }
      }
      await tx.domainVersionNode.create({data:{id:projectNodeId,kind:DomainVersionKind.PROJECT}});
      await tx.projectVersion.create({data:{
        id:projectVersionId,
        projectId,
        nodeId:projectNodeId,
        versionNumber:1,
        title:manifest.project.title,
        description:manifest.project.description,
        aspectRatio:manifest.projectVersion.aspectRatio,
        outputWidth:manifest.projectVersion.outputWidth,
        outputHeight:manifest.projectVersion.outputHeight,
        frameRate:manifest.projectVersion.frameRate,
        audioMasterAssetVersionId:audio?.newVersionId??null,
        specification:JSON.parse(JSON.stringify({
          restoredFrom:{
            projectId:manifest.source.projectId,
            projectVersionId:manifest.source.projectVersionId,
            exportedAt:manifest.exportedAt
          },
          ...(audio?{audioMaster:{immutable:true}}:{})
        })) as Prisma.InputJsonValue,
        createdByUserId:input.userId
      }});
      if(audio){
        await registerDependencyEdgeInTransaction(tx,{
          upstreamNodeId:audio.nodeId,
          downstreamNodeId:projectNodeId,
          relation:DependencyRelation.REFERENCES,
          reason:"Restored project version pins its restored immutable master audio."
        });
      }
    });
    uploadedKeys.length=0;

    const planned=manifest.wizard.steps.filter(step=>step.payload!==null&&step.stepKey!=="project-setup");
    return {
      projectId,
      projectVersionId,
      restoredMedia:staged.size,
      audioMasterRestored:Boolean(audio),
      missingMedia,
      notRestored:planned.length
        ?[planned.length+" wizard step result(s) ("+planned.map(step=>step.stepKey).join(", ")+") reference the source project and must be rebuilt; restored media is available in the new project."]
        :[]
    };
  }finally{
    for(const key of uploadedKeys) await storage.delete(key).catch(()=>undefined);
    await rm(directory,{recursive:true,force:true});
  }
}
