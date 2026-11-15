import { describe, expect, it } from "vitest";
import { animaticFrameAt, compileAnimaticPlan, type AnimaticSource } from "./compiler";

function shot(index:number,start:number,end:number,extra:Partial<AnimaticSource>={}):AnimaticSource{
  return {
    sequencePosition:0,
    shotPosition:index,
    label:"Shot "+index,
    shotSpecificationVersionId:"spec-"+index,
    shotSpecificationNodeId:"node-"+index,
    imageAssetVersionId:"image-"+index,
    timelineStartMs:start,
    timelineEndMs:end,
    transitionIn:"",
    transitionOut:"",
    ...extra
  };
}

describe("compileAnimaticPlan", () => {
  it("reuses First Cut timing order and continuity", () => {
    const plan=compileAnimaticPlan([shot(1,2000,5000),shot(0,0,2000)]);
    expect(plan.items.map(item=>[item.position,item.shotSpecificationVersionId,item.timelineStartMs,item.timelineEndMs]))
      .toEqual([[0,"spec-0",0,2000],[1,"spec-1",2000,5000]]);
    expect(plan.durationMs).toBe(5000);
    expect(plan.missingStillCount).toBe(0);
  });

  it("rejects gaps exactly like the First Cut compiler", () => {
    expect(()=>compileAnimaticPlan([shot(0,0,1000),shot(1,1500,3000)])).toThrow(/continuously/);
    expect(()=>compileAnimaticPlan([])).toThrow(/no storyboard shots/);
  });

  it("keeps shots without an approved still as explicit placeholders", () => {
    const plan=compileAnimaticPlan([shot(0,0,1000,{imageAssetVersionId:null}),shot(1,1000,2000)]);
    expect(plan.items[0]!.imageAssetVersionId).toBeNull();
    expect(plan.items[1]!.imageAssetVersionId).toBe("image-1");
    expect(plan.missingStillCount).toBe(1);
  });

  it("carries timed transition intent and allows any hold length for stills", () => {
    const plan=compileAnimaticPlan([
      shot(0,0,4000,{transitionOut:"cross dissolve 500ms"}),
      shot(1,4000,8000)
    ]);
    expect(plan.transitions).toEqual([{fromPosition:0,toPosition:1,kind:"DISSOLVE",durationMs:500}]);
  });
});

describe("animaticFrameAt", () => {
  const plan=compileAnimaticPlan([
    shot(0,0,4000,{transitionOut:"dissolve 1s"}),
    shot(1,4000,6000),
    shot(2,6000,9000)
  ]);

  it("selects the still under the audio clock", () => {
    expect(animaticFrameAt(plan,0)).toEqual({position:0,incomingPosition:null,incomingOpacity:0});
    expect(animaticFrameAt(plan,4000)?.position).toBe(1);
    expect(animaticFrameAt(plan,5999)?.position).toBe(1);
    expect(animaticFrameAt(plan,6000)?.position).toBe(2);
  });

  it("cross-fades during the transition window before the cut", () => {
    expect(animaticFrameAt(plan,3500)).toEqual({position:0,incomingPosition:1,incomingOpacity:0.5});
    expect(animaticFrameAt(plan,2999)?.incomingPosition).toBeNull();
  });

  it("clamps out-of-range times", () => {
    expect(animaticFrameAt(plan,-50)?.position).toBe(0);
    expect(animaticFrameAt(plan,60_000)?.position).toBe(2);
    expect(animaticFrameAt({items:[],transitions:[],durationMs:0},0)).toBeNull();
  });
});
