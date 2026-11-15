import { describe, expect, it } from "vitest";
import { estimateCostUsd, evaluateQuotas, quotaConfigFromEnv, summarizeUsage, type UsageRow } from "./usage";

function row(partial:Partial<UsageRow>):UsageRow{
  return {month:"2026-11",kind:"IMAGE",providerKey:"openai-images:initial-frame",modelKey:"gpt-image-1",status:"SUCCEEDED",jobs:1,requestedVideoSeconds:0,computeSeconds:0,...partial};
}

describe("estimated usage cost",()=>{
  it("prices only successful paid-provider jobs and keeps local providers free",()=>{
    expect(estimateCostUsd(row({jobs:3}))).toBe(0.12);
    expect(estimateCostUsd(row({status:"FAILED",jobs:3}))).toBe(0);
    expect(estimateCostUsd(row({providerKey:"ffmpeg:finish-export",kind:"RENDER",jobs:9}))).toBe(0);
    expect(estimateCostUsd(row({providerKey:"comfyui:video-clip",kind:"VIDEO"}))).toBe(0);
    expect(estimateCostUsd(row({providerKey:"local-librosa",kind:"ANALYSIS"}))).toBe(0);
    expect(estimateCostUsd(row({providerKey:"mystery-ai:thing"}))).toBeNull();
  });

  it("bills video per requested second with the provider minimum",()=>{
    expect(estimateCostUsd(row({providerKey:"runway:video-clip",kind:"VIDEO",jobs:2,requestedVideoSeconds:6}))).toBe(0.5);
    expect(estimateCostUsd(row({providerKey:"runway:video-clip",kind:"VIDEO",jobs:1,requestedVideoSeconds:10}))).toBe(0.5);
  });

  it("summarizes by month and provider",()=>{
    const summary=summarizeUsage([
      row({jobs:2}),
      row({status:"FAILED"}),
      row({providerKey:"openai-responses:treatment",kind:"TEXT",jobs:5,computeSeconds:30}),
      row({month:"2026-10",providerKey:"ffmpeg:finish-export",kind:"RENDER",jobs:4}),
      row({providerKey:"mystery-ai"})
    ]);
    expect(summary.months.map(month=>month.month)).toEqual(["2026-11","2026-10"]);
    expect(summary.months[0]).toMatchObject({jobs:9,succeeded:8,failed:1,paidJobs:9,estimatedUsd:0.18,unpricedJobs:1,computeSeconds:30});
    expect(summary.months[1]).toMatchObject({jobs:4,paidJobs:0,estimatedUsd:0});
    expect(summary.providers[0]).toMatchObject({providerKey:"openai-responses",estimatedUsd:0.1,priceLabel:expect.stringContaining("text")});
    expect(summary.providers.find(item=>item.providerKey==="ffmpeg")).toMatchObject({local:true,priceLabel:"Local: $0"});
    expect(summary.providers.find(item=>item.providerKey==="mystery-ai")?.priceLabel).toBe("Unpriced");
  });
});

describe("quotas",()=>{
  it("are opt-in from the environment",()=>{
    expect(quotaConfigFromEnv({})).toEqual({monthlyBudgetUsd:null,monthlyJobLimit:null,storageBytesLimit:null});
    expect(quotaConfigFromEnv({USAGE_MONTHLY_BUDGET_USD:"25",USAGE_MONTHLY_JOB_LIMIT:"100",USAGE_STORAGE_LIMIT_BYTES:"oops"}))
      .toEqual({monthlyBudgetUsd:25,monthlyJobLimit:100,storageBytesLimit:null});
  });

  it("reports unset, ok, warning and exceeded states",()=>{
    const month={month:"2026-11",jobs:90,succeeded:90,failed:0,paidJobs:10,estimatedUsd:30,unpricedJobs:0,computeSeconds:0};
    const states=evaluateQuotas({config:{monthlyBudgetUsd:25,monthlyJobLimit:100,storageBytesLimit:null},currentMonth:month,storageBytes:5})
      .map(item=>[item.key,item.state]);
    expect(states).toEqual([["monthlyBudgetUsd","exceeded"],["monthlyJobLimit","warning"],["storageBytesLimit","unset"]]);
    const zero=evaluateQuotas({config:{monthlyBudgetUsd:0,monthlyJobLimit:10,storageBytesLimit:1000},currentMonth:undefined,storageBytes:10});
    expect(zero.map(item=>item.state)).toEqual(["ok","ok","ok"]);
  });
});
