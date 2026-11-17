import type { ItemFraming, TimelineOverlay } from "@/lib/refinement/timeline";

export interface RenderSourceItem{
  position:number;
  shotVersionId:string;
  clipAssetVersionId:string;
  clipNodeId:string;
  contentType:string;
  timelineStartMs:number;
  timelineEndMs:number;
  sourceStartMs:number;
  sourceEndMs:number;
  clipDurationMs:number|null;
  /** Non-default crop/reframe; omitted = fit (letterbox). */
  framing?:ItemFraming|null;
}

export interface RenderSourceTransition{
  fromPosition:number;
  toPosition:number;
  kind:string;
  durationMs:number;
  parameters:unknown;
}

export interface CompileRenderManifestInput{
  projectVersionId:string;
  sourceTimelineVersionId:string;
  sourceTimelineNodeId:string;
  audioMasterAssetVersionId:string;
  audioMasterNodeId:string;
  audioContentType:string;
  audioDurationMs:number|null;
  width:number;
  height:number;
  frameRate:number;
  aspectRatio:string;
  items:RenderSourceItem[];
  transitions:RenderSourceTransition[];
  /** Burned-in titles and captions. */
  overlays?:readonly TimelineOverlay[];
}

export interface RenderManifest{
  schemaVersion:1;
  projectVersionId:string;
  sourceTimelineVersionId:string;
  sourceTimelineNodeId:string;
  audioMasterAssetVersionId:string;
  audioMasterNodeId:string;
  output:{
    width:number;
    height:number;
    frameRate:number;
    aspectRatio:string;
    container:"mp4";
    videoCodec:"h264";
    audioCodec:"aac";
    pixelFormat:"yuv420p";
    crf?:number;
  };
  durationMs:number;
  expectedFrameCount:number;
  items:Array<{
    position:number;
    shotVersionId:string;
    clipAssetVersionId:string;
    clipNodeId:string;
    timelineStartMs:number;
    timelineEndMs:number;
    sourceStartMs:number;
    sourceEndMs:number;
    framing?:ItemFraming;
  }>;
  transitions:RenderSourceTransition[];
  /** Present only when titles/captions exist, so older manifests keep their fingerprint. */
  overlays?:TimelineOverlay[];
}

export function compileRenderManifest(
  input:CompileRenderManifestInput
):RenderManifest{
  if(
    !Number.isInteger(input.width)||
    !Number.isInteger(input.height)||
    input.width<=0||
    input.height<=0||
    input.width%2!==0||
    input.height%2!==0
  ){
    throw new Error(
      "Export dimensions must be positive even integers for yuv420p delivery."
    );
  }
  if(
    !Number.isFinite(input.frameRate)||
    input.frameRate<=0||
    input.frameRate>120
  ){
    throw new Error("Export frame rate must be greater than 0 and at most 120 fps.");
  }
  if(!input.audioContentType.startsWith("audio/")){
    throw new Error("Finish & Export requires a valid audio-master asset.");
  }
  if(!input.items.length){
    throw new Error("Finish & Export requires at least one video timeline item.");
  }

  const items=[...input.items].sort((a,b)=>a.position-b.position);
  if(items[0]!.timelineStartMs!==0){
    throw new Error("Render timeline must begin at 0 ms.");
  }

  let previousEnd=0;
  for(let index=0;index<items.length;index++){
    const item=items[index]!;
    if(item.position!==index){
      throw new Error("Render timeline positions must be contiguous.");
    }
    if(!item.contentType.startsWith("video/")){
      throw new Error("Every render timeline item must reference a video asset.");
    }
    if(
      item.timelineStartMs!==previousEnd||
      item.timelineEndMs<=item.timelineStartMs
    ){
      throw new Error(
        "Render timeline must cover time continuously without gaps or overlaps."
      );
    }
    const timelineDuration=item.timelineEndMs-item.timelineStartMs;
    if(
      item.sourceStartMs<0||
      item.sourceEndMs<=item.sourceStartMs||
      item.sourceEndMs-item.sourceStartMs!==timelineDuration
    ){
      throw new Error(
        "Render source ranges must exactly match editorial item durations."
      );
    }
    if(
      item.clipDurationMs!==null&&
      item.sourceEndMs>item.clipDurationMs
    ){
      throw new Error(
        "A render item requests source media beyond the selected clip duration."
      );
    }
    previousEnd=item.timelineEndMs;
  }

  const transitions=[...input.transitions].sort(
    (a,b)=>a.fromPosition-b.fromPosition
  );
  const seen=new Set<number>();
  for(const transition of transitions){
    if(
      transition.fromPosition<0||
      transition.toPosition!==transition.fromPosition+1||
      transition.toPosition>=items.length||
      seen.has(transition.fromPosition)
    ){
      throw new Error(
        "Render transitions must uniquely connect adjacent timeline items."
      );
    }
    seen.add(transition.fromPosition);
    const outgoing=items[transition.fromPosition]!;
    const incoming=items[transition.toPosition]!;
    const maxEditorial=Math.min(
      outgoing.timelineEndMs-outgoing.timelineStartMs,
      incoming.timelineEndMs-incoming.timelineStartMs
    );
    if(
      transition.durationMs<0||
      transition.durationMs>maxEditorial
    ){
      throw new Error(
        "Render transition duration exceeds adjacent editorial media."
      );
    }
    if(
      transition.durationMs>0&&
      outgoing.clipDurationMs!==null&&
      outgoing.sourceEndMs+transition.durationMs>
        outgoing.clipDurationMs
    ){
      throw new Error(
        "Render transition requires more outgoing clip tail than the source contains."
      );
    }
  }

  const durationMs=items[items.length-1]!.timelineEndMs;
  if(input.audioDurationMs!==null){
    const frameToleranceMs=Math.max(50,Math.ceil(1000/input.frameRate));
    if(Math.abs(input.audioDurationMs-durationMs)>frameToleranceMs){
      throw new Error(
        "Locked timeline duration does not match the immutable audio master within one-frame tolerance."
      );
    }
  }

  const overlays=[...(input.overlays??[])].sort((a,b)=>a.startMs-b.startMs);
  for(const overlay of overlays){
    if(overlay.startMs<0||overlay.endMs<=overlay.startMs||overlay.endMs>durationMs||!overlay.text.trim()){
      throw new Error("Render overlays must contain text and fall inside the timeline.");
    }
  }

  return {
    schemaVersion:1,
    projectVersionId:input.projectVersionId,
    sourceTimelineVersionId:input.sourceTimelineVersionId,
    sourceTimelineNodeId:input.sourceTimelineNodeId,
    audioMasterAssetVersionId:input.audioMasterAssetVersionId,
    audioMasterNodeId:input.audioMasterNodeId,
    output:{
      width:input.width,
      height:input.height,
      frameRate:input.frameRate,
      aspectRatio:input.aspectRatio,
      container:"mp4",
      videoCodec:"h264",
      audioCodec:"aac",
      pixelFormat:"yuv420p"
    },
    durationMs,
    expectedFrameCount:Math.round(
      durationMs/1000*input.frameRate
    ),
    items:items.map(item=>({
      position:item.position,
      shotVersionId:item.shotVersionId,
      clipAssetVersionId:item.clipAssetVersionId,
      clipNodeId:item.clipNodeId,
      timelineStartMs:item.timelineStartMs,
      timelineEndMs:item.timelineEndMs,
      sourceStartMs:item.sourceStartMs,
      sourceEndMs:item.sourceEndMs,
      ...(item.framing?{framing:{...item.framing}}:{})
    })),
    transitions,
    ...(overlays.length?{overlays:overlays.map(item=>({...item}))}:{})
  };
}
