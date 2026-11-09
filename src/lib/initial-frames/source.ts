import {
  AssetKind,
  Prisma,
  VersionLifecycle
} from "@prisma/client";
import { shotSpecificationSpecSchema } from "@/lib/shot-specifications/schema";

export interface InitialFrameMetadata{
  role:"initial-frame";
  logicalShotId:string;
  sourceShotSpecificationVersionId:string;
  sourceStoryboardShotVersionId:string;
  generationJobId:string|null;
  origin?:"import";
  providerId:string;
  modelId:string;
}

export function parseInitialFrameMetadata(
  value:unknown
):InitialFrameMetadata|null{
  if(!value||typeof value!=="object"||Array.isArray(value)) return null;
  const item=value as Record<string,unknown>;
  if(
    item.role!=="initial-frame"||
    typeof item.logicalShotId!=="string"||
    typeof item.sourceShotSpecificationVersionId!=="string"||
    typeof item.sourceStoryboardShotVersionId!=="string"||
    (typeof item.generationJobId!=="string"&&!(item.generationJobId===null&&item.origin==="import"&&item.providerId==="user-import"))||
    typeof item.providerId!=="string"||
    typeof item.modelId!=="string"
  ) return null;
  return item as unknown as InitialFrameMetadata;
}

export async function lockedShotSpecificationSources(
  tx:Prisma.TransactionClient,
  projectVersionId:string
){
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

  const storyboard=sequenceLinks.flatMap(sequenceLink=>
    sequenceLink.sequenceVersion.shotLinks.map(shotLink=>({
      sequencePosition:sequenceLink.position,
      shotPosition:shotLink.position,
      storyboardVersion:shotLink.shotVersion
    }))
  );
  if(!storyboard.length) return [];

  const shotIds=[...new Set(storyboard.map(item=>item.storyboardVersion.shotId))];
  const candidates=await tx.shotVersion.findMany({
    where:{
      shotId:{in:shotIds},
      lifecycle:VersionLifecycle.LOCKED
    },
    orderBy:[{shotId:"asc"},{versionNumber:"desc"}]
  });
  const byShot=new Map<string,typeof candidates>();
  for(const candidate of candidates){
    const list=byShot.get(candidate.shotId)??[];
    list.push(candidate);
    byShot.set(candidate.shotId,list);
  }

  return storyboard.map(item=>{
    const specificationVersion=(byShot.get(item.storyboardVersion.shotId)??[])
      .find(candidate=>{
        const parsed=shotSpecificationSpecSchema.safeParse(
          candidate.structuredSpec
        );
        return parsed.success&&
          parsed.data.sourceStoryboardShotVersionId===item.storyboardVersion.id;
      })??null;
    const parsed=specificationVersion
      ?shotSpecificationSpecSchema.safeParse(specificationVersion.structuredSpec)
      :null;
    return {
      ...item,
      specificationVersion,
      specification:parsed?.success?parsed.data:null
    };
  });
}

export async function initialFrameAssetsForProject(
  tx:Prisma.TransactionClient,
  projectId:string
){
  return tx.asset.findMany({
    where:{
      projectId,
      kind:AssetKind.GENERATED_IMAGE
    },
    include:{
      versions:{
        orderBy:{versionNumber:"desc"}
      }
    },
    orderBy:{createdAt:"asc"}
  });
}

export function currentFrameVersions(
  sources:Awaited<ReturnType<typeof lockedShotSpecificationSources>>,
  assets:Awaited<ReturnType<typeof initialFrameAssetsForProject>>
){
  return sources.map(source=>{
    const sourceId=source.specificationVersion?.id;
    let asset:null|(typeof assets)[number]=null;
    let version:null|(typeof assets)[number]["versions"][number]=null;
    if(sourceId){
      for(const candidateAsset of assets){
        const candidateVersion=candidateAsset.versions.find(item=>
          item.status==="READY"&&parseInitialFrameMetadata(item.metadata)
            ?.sourceShotSpecificationVersionId===sourceId
        );
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
