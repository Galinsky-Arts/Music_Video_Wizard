/**
 * Usage and estimated-cost accounting. Providers do not report billed amounts
 * back to the app, so costs are ESTIMATES from published list prices and are
 * labelled as such everywhere they are shown. Local providers cost $0.
 */

export interface UsageRow{
  month:string; // YYYY-MM (UTC)
  kind:string;
  providerKey:string;
  modelKey:string|null;
  status:string;
  jobs:number;
  /** Sum of requested generation seconds (video only). */
  requestedVideoSeconds:number;
  /** Sum of wall-clock seconds between start and completion. */
  computeSeconds:number;
}

export interface UnitPrice{
  /** Price per successful job, or per billed video second when perSecond. */
  usd:number;
  perSecond?:boolean;
  /** Minimum billed seconds per job (video providers round up). */
  minimumSeconds?:number;
  label:string;
}

const LOCAL_PROVIDERS=["local-librosa","ffmpeg","comfyui","mac-gpu","browser-gpu","user-import","local"];

/** Estimated list prices (USD). Update when provider pricing changes. */
export const ESTIMATED_PRICES:Record<string,UnitPrice>={
  "openai-responses":{usd:0.02,label:"~$0.02 per text generation"},
  "openai-images":{usd:0.04,label:"~$0.04 per image"},
  "stability-images":{usd:0.03,label:"~$0.03 per image (3 credits)"},
  "runway":{usd:0.05,perSecond:true,minimumSeconds:5,label:"~$0.05 per video second (5 s minimum)"}
};

export function providerBase(providerKey:string){
  return providerKey.split(":")[0]!.trim().toLowerCase();
}

export function isLocalProvider(providerKey:string){
  return LOCAL_PROVIDERS.includes(providerBase(providerKey));
}

/**
 * Estimated USD for a group of jobs. Only SUCCEEDED jobs are counted as
 * billable; null means the provider has no known price (shown as "unpriced").
 */
export function estimateCostUsd(row:Pick<UsageRow,"providerKey"|"status"|"jobs"|"requestedVideoSeconds">):number|null{
  if(isLocalProvider(row.providerKey)) return 0;
  const price=ESTIMATED_PRICES[providerBase(row.providerKey)];
  if(!price) return null;
  if(row.status!=="SUCCEEDED") return 0;
  if(price.perSecond){
    const seconds=Math.max(row.requestedVideoSeconds,row.jobs*(price.minimumSeconds??0));
    return round(seconds*price.usd);
  }
  return round(row.jobs*price.usd);
}

function round(value:number){
  return Math.round(value*10000)/10000;
}

export interface MonthSummary{
  month:string;
  jobs:number;
  succeeded:number;
  failed:number;
  paidJobs:number;
  estimatedUsd:number;
  unpricedJobs:number;
  computeSeconds:number;
}

export interface ProviderSummary{
  providerKey:string;
  kind:string;
  jobs:number;
  succeeded:number;
  estimatedUsd:number;
  local:boolean;
  priceLabel:string;
}

export function summarizeUsage(rows:readonly UsageRow[]){
  const months=new Map<string,MonthSummary>();
  const providers=new Map<string,ProviderSummary>();
  for(const row of rows){
    const cost=estimateCostUsd(row);
    const month=months.get(row.month)??{
      month:row.month,jobs:0,succeeded:0,failed:0,paidJobs:0,estimatedUsd:0,unpricedJobs:0,computeSeconds:0
    };
    month.jobs+=row.jobs;
    if(row.status==="SUCCEEDED") month.succeeded+=row.jobs;
    if(row.status==="FAILED") month.failed+=row.jobs;
    if(!isLocalProvider(row.providerKey)) month.paidJobs+=row.jobs;
    if(cost===null) month.unpricedJobs+=row.jobs;
    else month.estimatedUsd=round(month.estimatedUsd+cost);
    month.computeSeconds+=row.computeSeconds;
    months.set(row.month,month);

    const base=providerBase(row.providerKey);
    const key=base+"|"+row.kind;
    const provider=providers.get(key)??{
      providerKey:base,
      kind:row.kind,
      jobs:0,
      succeeded:0,
      estimatedUsd:0,
      local:isLocalProvider(row.providerKey),
      priceLabel:isLocalProvider(row.providerKey)
        ?"Local: $0"
        :ESTIMATED_PRICES[base]?.label??"Unpriced"
    };
    provider.jobs+=row.jobs;
    if(row.status==="SUCCEEDED") provider.succeeded+=row.jobs;
    provider.estimatedUsd=round(provider.estimatedUsd+(cost??0));
    providers.set(key,provider);
  }
  return {
    months:[...months.values()].sort((a,b)=>b.month.localeCompare(a.month)),
    providers:[...providers.values()].sort((a,b)=>b.estimatedUsd-a.estimatedUsd||b.jobs-a.jobs)
  };
}

export interface QuotaConfig{
  monthlyBudgetUsd:number|null;
  monthlyJobLimit:number|null;
  storageBytesLimit:number|null;
}

export type QuotaState="unset"|"ok"|"warning"|"exceeded";

export interface QuotaStatus{
  key:"monthlyBudgetUsd"|"monthlyJobLimit"|"storageBytesLimit";
  label:string;
  used:number;
  limit:number|null;
  ratio:number|null;
  state:QuotaState;
}

function positiveOrNull(value:string|undefined){
  if(value===undefined||value.trim()==="") return null;
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?number:null;
}

/** Quotas are opt-in via environment variables; unset means "not limited". */
export function quotaConfigFromEnv(env:Record<string,string|undefined>=process.env):QuotaConfig{
  return {
    monthlyBudgetUsd:positiveOrNull(env.USAGE_MONTHLY_BUDGET_USD),
    monthlyJobLimit:positiveOrNull(env.USAGE_MONTHLY_JOB_LIMIT),
    storageBytesLimit:positiveOrNull(env.USAGE_STORAGE_LIMIT_BYTES)
  };
}

function quota(key:QuotaStatus["key"],label:string,used:number,limit:number|null):QuotaStatus{
  if(limit===null) return {key,label,used,limit,ratio:null,state:"unset"};
  const ratio=limit===0?(used>0?Infinity:0):used/limit;
  const state:QuotaState=used>0&&used>=limit?"exceeded":ratio>=0.8?"warning":"ok";
  return {key,label,used,limit,ratio,state};
}

export function evaluateQuotas(input:{
  config:QuotaConfig;
  currentMonth:MonthSummary|undefined;
  storageBytes:number;
}):QuotaStatus[]{
  return [
    quota("monthlyBudgetUsd","Estimated paid-provider spend this month (USD)",input.currentMonth?.estimatedUsd??0,input.config.monthlyBudgetUsd),
    quota("monthlyJobLimit","Generation jobs this month",input.currentMonth?.jobs??0,input.config.monthlyJobLimit),
    quota("storageBytesLimit","Stored media (bytes)",input.storageBytes,input.config.storageBytesLimit)
  ];
}
