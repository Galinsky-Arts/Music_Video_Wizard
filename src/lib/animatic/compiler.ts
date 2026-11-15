import { compileFirstCutPlan, type FirstCutSource } from "@/lib/first-cut/compiler";

/** One storyboard shot with its locked timing and (optionally) an approved still. */
export interface AnimaticSource{
  sequencePosition:number;
  shotPosition:number;
  label:string|null;
  shotSpecificationVersionId:string;
  shotSpecificationNodeId:string;
  /** Approved Initial Frame asset version, or null when the still is missing. */
  imageAssetVersionId:string|null;
  timelineStartMs:number;
  timelineEndMs:number;
  transitionIn:string;
  transitionOut:string;
}

export interface AnimaticItem{
  position:number;
  label:string|null;
  shotSpecificationVersionId:string;
  imageAssetVersionId:string|null;
  timelineStartMs:number;
  timelineEndMs:number;
}

export interface AnimaticTransition{
  fromPosition:number;
  toPosition:number;
  kind:string;
  durationMs:number;
}

export interface AnimaticPlan{
  schemaVersion:1;
  items:AnimaticItem[];
  transitions:AnimaticTransition[];
  durationMs:number;
  missingStillCount:number;
}

const MISSING_STILL_PREFIX="missing-still:";

/**
 * Compiles an audio-synced still sequence using exactly the same timing,
 * continuity and transition rules as the Automatic First Cut. Stills have no
 * intrinsic duration, so a still can hold for any editorial length.
 */
export function compileAnimaticPlan(input:readonly AnimaticSource[]):AnimaticPlan{
  if(!input.length) throw new Error("The animatic has no storyboard shots.");
  const sources:FirstCutSource[]=input.map(source=>({
    sequencePosition:source.sequencePosition,
    shotPosition:source.shotPosition,
    label:source.label,
    shotSpecificationVersionId:source.shotSpecificationVersionId,
    shotSpecificationNodeId:source.shotSpecificationNodeId,
    clipAssetVersionId:source.imageAssetVersionId??MISSING_STILL_PREFIX+source.shotSpecificationVersionId,
    clipNodeId:source.shotSpecificationNodeId,
    timelineStartMs:source.timelineStartMs,
    timelineEndMs:source.timelineEndMs,
    generatedDurationMs:null,
    transitionIn:source.transitionIn,
    transitionOut:source.transitionOut
  }));
  const plan=compileFirstCutPlan(sources);
  const items=plan.items.map(item=>({
    position:item.position,
    label:item.label,
    shotSpecificationVersionId:item.shotSpecificationVersionId,
    imageAssetVersionId:item.clipAssetVersionId.startsWith(MISSING_STILL_PREFIX)
      ?null
      :item.clipAssetVersionId,
    timelineStartMs:item.timelineStartMs,
    timelineEndMs:item.timelineEndMs
  }));
  return {
    schemaVersion:1,
    items,
    transitions:plan.transitions.map(transition=>({
      fromPosition:transition.fromPosition,
      toPosition:transition.toPosition,
      kind:transition.kind,
      durationMs:transition.durationMs
    })),
    durationMs:plan.durationMs,
    missingStillCount:items.filter(item=>!item.imageAssetVersionId).length
  };
}

export interface AnimaticFrame{
  /** Item fully visible underneath. */
  position:number;
  /** Item fading in on top during a timed transition, if any. */
  incomingPosition:number|null;
  /** Opacity of the incoming item, 0..1. */
  incomingOpacity:number;
}

/**
 * Resolves which still(s) are visible at a playback time. A timed transition
 * of duration d starts d ms before the outgoing item's end, matching the
 * export's xfade placement. Pure and O(log n) so it can run every animation
 * frame against the playing audio clock.
 */
export function animaticFrameAt(
  plan:Pick<AnimaticPlan,"items"|"transitions"|"durationMs">,
  timeMs:number
):AnimaticFrame|null{
  const items=plan.items;
  if(!items.length) return null;
  const t=Math.min(Math.max(timeMs,0),Math.max(plan.durationMs-1,0));
  let low=0;
  let high=items.length-1;
  while(low<high){
    const middle=(low+high+1)>>1;
    if(items[middle]!.timelineStartMs<=t) low=middle;
    else high=middle-1;
  }
  const current=items[low]!;
  const transition=plan.transitions.find(item=>item.fromPosition===current.position);
  if(transition&&transition.durationMs>0){
    const start=current.timelineEndMs-transition.durationMs;
    if(t>=start){
      return {
        position:current.position,
        incomingPosition:transition.toPosition,
        incomingOpacity:Math.min(1,(t-start)/transition.durationMs)
      };
    }
  }
  return {position:current.position,incomingPosition:null,incomingOpacity:0};
}
