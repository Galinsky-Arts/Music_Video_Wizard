import { db } from "@/lib/db";
import { ensurePersonalWorkspace } from "@/lib/workspaces";
import {
  estimateCostUsd,
  evaluateQuotas,
  isLocalProvider,
  quotaConfigFromEnv,
  summarizeUsage,
  type UsageRow
} from "./usage";

export const USAGE_HISTORY_MONTHS=6;

function monthKey(date:Date){
  return date.toISOString().slice(0,7);
}

/**
 * Usage, estimated cost and quota status for the caller's personal workspace.
 * Aggregation happens in PostgreSQL so memory stays constant as history grows.
 */
export async function getWorkspaceUsage(input:{userId:string;displayName:string;now?:Date}){
  const now=input.now??new Date();
  const workspace=await ensurePersonalWorkspace(input.userId,input.displayName);
  const since=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-(USAGE_HISTORY_MONTHS-1),1));

  const grouped=await db.$queryRaw<Array<{
    month:Date;
    kind:string;
    providerKey:string;
    modelKey:string|null;
    status:string;
    jobs:bigint;
    requestedVideoSeconds:number|null;
    computeSeconds:number|null;
  }>>`
    SELECT date_trunc('month', "createdAt" AT TIME ZONE 'UTC') AS month,
           "kind"::text AS kind,
           "providerKey" AS "providerKey",
           "modelKey" AS "modelKey",
           "status"::text AS status,
           count(*) AS jobs,
           COALESCE(sum(CASE WHEN "kind" = 'VIDEO'
             THEN NULLIF("requestSnapshot"->'request'->>'generationDurationMs','')::numeric / 1000 END), 0)::float8 AS "requestedVideoSeconds",
           COALESCE(sum(EXTRACT(EPOCH FROM ("completedAt" - "startedAt"))), 0)::float8 AS "computeSeconds"
      FROM "GenerationJob"
     WHERE "workspaceId" = ${workspace.id}::uuid
       AND "createdAt" >= ${since}
     GROUP BY 1, 2, 3, 4, 5
  `;
  const rows:UsageRow[]=grouped.map(row=>({
    month:monthKey(row.month),
    kind:row.kind,
    providerKey:row.providerKey,
    modelKey:row.modelKey,
    status:row.status,
    jobs:Number(row.jobs),
    requestedVideoSeconds:Number(row.requestedVideoSeconds??0),
    computeSeconds:Math.round(Number(row.computeSeconds??0))
  }));
  const summary=summarizeUsage(rows);

  const [storage]=await db.$queryRaw<Array<{bytes:bigint|null;files:bigint}>>`
    SELECT COALESCE(sum(v."byteSize"), 0)::bigint AS bytes, count(*) AS files
      FROM "AssetVersion" v
      JOIN "Asset" a ON a."id" = v."assetId"
     WHERE a."workspaceId" = ${workspace.id}::uuid
  `;
  const storageBytes=Number(storage?.bytes??0);

  const recent=await db.generationJob.findMany({
    where:{workspaceId:workspace.id},
    orderBy:{createdAt:"desc"},
    take:25,
    select:{
      id:true,kind:true,providerKey:true,modelKey:true,status:true,createdAt:true,
      startedAt:true,completedAt:true,requestSnapshot:true,
      project:{select:{id:true,title:true}}
    }
  });

  const currentMonth=summary.months.find(month=>month.month===monthKey(now));
  return {
    workspace:{id:workspace.id,name:workspace.name},
    generatedAt:now.toISOString(),
    since:since.toISOString(),
    months:summary.months,
    providers:summary.providers,
    storage:{bytes:storageBytes,files:Number(storage?.files??0)},
    quotas:evaluateQuotas({config:quotaConfigFromEnv(),currentMonth,storageBytes}),
    recent:recent.map(job=>{
      const request=(job.requestSnapshot as {request?:{generationDurationMs?:unknown}}|null)?.request;
      const durationMs=typeof request?.generationDurationMs==="number"?request.generationDurationMs:0;
      return {
        id:job.id,
        kind:job.kind,
        providerKey:job.providerKey,
        modelKey:job.modelKey,
        status:job.status,
        createdAt:job.createdAt.toISOString(),
        project:job.project,
        local:isLocalProvider(job.providerKey),
        estimatedUsd:estimateCostUsd({providerKey:job.providerKey,status:job.status,jobs:1,requestedVideoSeconds:durationMs/1000}),
        computeSeconds:job.startedAt&&job.completedAt
          ?Math.round((job.completedAt.getTime()-job.startedAt.getTime())/1000)
          :null
      };
    })
  };
}
