import { AssetKind,Prisma } from "@prisma/client";
import {
  currentFrameVersions,
  initialFrameAssetsForProject,
  lockedShotSpecificationSources
} from "@/lib/initial-frames/source";

export interface VideoClipMetadata{
  role:"video-clip";
  logicalShotId:string;
  sourceShotSpecificationVersionId:string;
  sourceInitialFrameAssetVersionId:string;
  sourceStoryboardShotVersionId:string;
  generationJobId:string|null;
  origin?:"import";
  providerId:string;
  modelId:string;
  editorialDurationMs:number;
  generatedDurationMs:number;
}

export function parseVideoClipMetadata(value:unknown):VideoClipMetadata|null{
  if(!value||typeof value!=="object"||Array.isArray(value)) return null;
  const item=value as Record<string,unknown>;
  if(
    item.role!=="video-clip"||
    typeof item.logicalShotId!=="string"||
    typeof item.sourceShotSpecificationVersionId!=="string"||
    typeof item.sourceInitialFrameAssetVersionId!=="string"||
    typeof item.sourceStoryboardShotVersionId!=="string"||
    (typeof item.generationJobId!=="string"&&!(item.generationJobId===null&&item.origin==="import"&&item.providerId==="user-import"))||
    typeof item.providerId!=="string"||
    typeof item.modelId!=="string"||
    typeof item.editorialDurationMs!=="number"||
    typeof item.generatedDurationMs!=="number"
  ) return null;
  return item as unknown as VideoClipMetadata;
}

export async function lockedVideoClipSources(
  tx:Prisma.TransactionClient,
  projectId:string,
  projectVersionId:string
){
  const specifications=await lockedShotSpecificationSources(
    tx,
    projectVersionId
  );
  const frameAssets=await initialFrameAssetsForProject(tx,projectId);
  return currentFrameVersions(specifications,frameAssets);
}

export async function videoClipAssetsForProject(
  tx:Prisma.TransactionClient,
  projectId:string
){
  return tx.asset.findMany({
    where:{
      projectId,
      kind:AssetKind.GENERATED_VIDEO
    },
    include:{
      versions:{
        orderBy:{versionNumber:"desc"}
      }
    },
    orderBy:{createdAt:"asc"}
  });
}

export function currentVideoClipVersions(
  sources:Awaited<ReturnType<typeof lockedVideoClipSources>>,
  assets:Awaited<ReturnType<typeof videoClipAssetsForProject>>
){
  return sources.map(source=>{
    const specId=source.source.specificationVersion?.id;
    const frameId=source.version?.id;
    let asset:null|(typeof assets)[number]=null;
    let version:null|(typeof assets)[number]["versions"][number]=null;
    if(specId&&frameId){
      for(const candidateAsset of assets){
        const candidateVersion=candidateAsset.versions.find(item=>{
          if(item.status!=="READY") return false;
          const metadata=parseVideoClipMetadata(item.metadata);
          return metadata?.sourceShotSpecificationVersionId===specId&&
            metadata.sourceInitialFrameAssetVersionId===frameId;
        });
        if(candidateVersion){
          asset=candidateAsset;
          version=candidateVersion;
          break;
        }
      }
    }
    return {source,asset,version};
  });
}
