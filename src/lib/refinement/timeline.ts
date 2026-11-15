export interface WorkingItemSnapshot{
  position:number;
  shotVersionId:string;
  assetVersionId:string;
  assetNodeId:string;
  timelineStartMs:number;
  timelineEndMs:number;
  sourceStartMs:number;
  sourceEndMs:number;
  manualOverride:boolean;
  parameters:unknown;
  availableDurationMs:number|null;
}

export interface WorkingTransitionSnapshot{
  fromPosition:number;
  toPosition:number;
  kind:string;
  durationMs:number;
  parameters:unknown;
}

export interface WorkingTimelineSnapshot{
  items:WorkingItemSnapshot[];
  transitions:WorkingTransitionSnapshot[];
  /** Titles and captions; persisted on the TITLE track. Absent = none. */
  overlays?:TimelineOverlay[];
}

/** Per-shot crop/reframe stored in a VIDEO item's parameters.framing. */
export interface ItemFraming{
  /** fit = letterbox/pillarbox whole frame; fill = cover output then crop. */
  mode:"fit"|"fill";
  /** 1 = no extra zoom; up to 4x punch-in (applies to fill). */
  zoom:number;
  /** Crop anchor 0..1 (0.5 = centered). */
  focusX:number;
  focusY:number;
}

export const DEFAULT_FRAMING:ItemFraming={mode:"fit",zoom:1,focusX:0.5,focusY:0.5};

export type OverlayKind="title"|"caption";
export type OverlayPlacement="top"|"center"|"bottom";

export interface TimelineOverlay{
  kind:OverlayKind;
  text:string;
  startMs:number;
  endMs:number;
  placement:OverlayPlacement;
}

export const MAX_TITLES=20;
export const MAX_CAPTIONS=600;
export const MAX_OVERLAY_TEXT=200;

function finiteIn(value:unknown,min:number,max:number):value is number{
  return typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max;
}

/** Returns the validated framing for an item, or null when none/invalid. */
export function parseItemFraming(parameters:unknown):ItemFraming|null{
  if(!parameters||typeof parameters!=="object"||Array.isArray(parameters)) return null;
  const framing=(parameters as Record<string,unknown>).framing;
  if(!framing||typeof framing!=="object"||Array.isArray(framing)) return null;
  const value=framing as Record<string,unknown>;
  if(
    (value.mode!=="fit"&&value.mode!=="fill")||
    !finiteIn(value.zoom,1,4)||
    !finiteIn(value.focusX,0,1)||
    !finiteIn(value.focusY,0,1)
  ) return null;
  return {mode:value.mode,zoom:value.zoom,focusX:value.focusX,focusY:value.focusY};
}

function isDefaultFraming(framing:ItemFraming){
  return framing.mode===DEFAULT_FRAMING.mode&&framing.zoom===1&&
    framing.focusX===0.5&&framing.focusY===0.5;
}

function validateOverlays(overlays:readonly TimelineOverlay[],durationMs:number){
  let titles=0;
  const captions:TimelineOverlay[]=[];
  for(const overlay of overlays){
    if(overlay.kind!=="title"&&overlay.kind!=="caption"){
      throw new Error("Overlay kind must be title or caption.");
    }
    if(!["top","center","bottom"].includes(overlay.placement)){
      throw new Error("Overlay placement must be top, center, or bottom.");
    }
    const text=overlay.text;
    if(
      typeof text!=="string"||!text.trim()||text.length>MAX_OVERLAY_TEXT||
      /[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)
    ){
      throw new Error(
        "Overlay text must be 1-"+MAX_OVERLAY_TEXT+" printable characters."
      );
    }
    if(
      !Number.isInteger(overlay.startMs)||!Number.isInteger(overlay.endMs)||
      overlay.startMs<0||overlay.endMs<=overlay.startMs||overlay.endMs>durationMs
    ){
      throw new Error("Overlay timing must fall inside the timeline.");
    }
    if(overlay.kind==="title") titles++;
    else captions.push(overlay);
  }
  if(titles>MAX_TITLES) throw new Error("At most "+MAX_TITLES+" titles are supported.");
  if(captions.length>MAX_CAPTIONS){
    throw new Error("At most "+MAX_CAPTIONS+" captions are supported.");
  }
  captions.sort((a,b)=>a.startMs-b.startMs);
  for(let index=1;index<captions.length;index++){
    if(captions[index]!.startMs<captions[index-1]!.endMs){
      throw new Error("Captions cannot overlap.");
    }
  }
}

function cloneSnapshot(snapshot:WorkingTimelineSnapshot):WorkingTimelineSnapshot{
  const result:WorkingTimelineSnapshot={
    items:snapshot.items.map(item=>({...item})),
    transitions:snapshot.transitions.map(item=>({...item}))
  };
  if(snapshot.overlays) result.overlays=snapshot.overlays.map(item=>({...item}));
  return result;
}

export function validateWorkingTimeline(
  snapshot:WorkingTimelineSnapshot
):void{
  if(!snapshot.items.length){
    throw new Error("Refinement timeline has no video items.");
  }
  const items=[...snapshot.items].sort((a,b)=>a.position-b.position);
  if(items[0]!.timelineStartMs!==0){
    throw new Error("Refinement timeline must begin at 0 ms.");
  }

  let previousEnd=0;
  for(let index=0;index<items.length;index++){
    const item=items[index]!;
    if(item.position!==index){
      throw new Error("Refinement timeline positions must be contiguous.");
    }
    if(
      item.timelineStartMs!==previousEnd||
      item.timelineEndMs<=item.timelineStartMs
    ){
      throw new Error(
        "Refinement timeline must remain continuous without gaps or overlaps."
      );
    }
    const editorial=item.timelineEndMs-item.timelineStartMs;
    if(
      item.sourceStartMs<0||
      item.sourceEndMs<=item.sourceStartMs||
      item.sourceEndMs-item.sourceStartMs!==editorial
    ){
      throw new Error(
        "Refinement source ranges must exactly match timeline durations."
      );
    }
    if(
      item.availableDurationMs!==null&&
      item.sourceEndMs>item.availableDurationMs
    ){
      throw new Error(
        "A refinement edit requires more source duration than the selected clip contains."
      );
    }
    if(
      item.parameters&&typeof item.parameters==="object"&&
      "framing" in (item.parameters as Record<string,unknown>)&&
      !parseItemFraming(item.parameters)
    ){
      throw new Error("Shot framing must use fit/fill, zoom 1-4, and focus 0-1.");
    }
    previousEnd=item.timelineEndMs;
  }

  if(snapshot.overlays) validateOverlays(snapshot.overlays,previousEnd);

  for(const transition of snapshot.transitions){
    if(
      transition.toPosition!==transition.fromPosition+1||
      transition.fromPosition<0||
      transition.toPosition>=items.length
    ){
      throw new Error("Refinement transitions must connect adjacent items.");
    }
    const outgoing=items[transition.fromPosition]!;
    const incoming=items[transition.toPosition]!;
    const maxDuration=Math.min(
      outgoing.timelineEndMs-outgoing.timelineStartMs,
      incoming.timelineEndMs-incoming.timelineStartMs
    );
    if(
      transition.durationMs<0||
      transition.durationMs>maxDuration
    ){
      throw new Error(
        "Transition duration cannot exceed either adjacent timeline item."
      );
    }
    if(
      transition.durationMs>0&&
      outgoing.availableDurationMs!==null&&
      outgoing.sourceEndMs+transition.durationMs>
        outgoing.availableDurationMs
    ){
      throw new Error(
        "Transition duration requires more outgoing clip tail than the selected clip contains."
      );
    }
  }
}

export function retimeBoundary(
  snapshot:WorkingTimelineSnapshot,
  boundaryPosition:number,
  timelineMs:number
):WorkingTimelineSnapshot{
  const result=cloneSnapshot(snapshot);
  const items=result.items;
  const outgoing=items[boundaryPosition];
  const incoming=items[boundaryPosition+1];
  if(!outgoing||!incoming){
    throw new Error("Selected refinement boundary does not exist.");
  }
  if(
    timelineMs<=outgoing.timelineStartMs||
    timelineMs>=incoming.timelineEndMs
  ){
    throw new Error(
      "A cut boundary must remain inside the combined adjacent shot range."
    );
  }

  outgoing.timelineEndMs=timelineMs;
  outgoing.sourceEndMs=
    outgoing.sourceStartMs+
    (outgoing.timelineEndMs-outgoing.timelineStartMs);
  outgoing.manualOverride=true;

  incoming.timelineStartMs=timelineMs;
  incoming.sourceEndMs=
    incoming.sourceStartMs+
    (incoming.timelineEndMs-incoming.timelineStartMs);
  incoming.manualOverride=true;

  validateWorkingTimeline(result);
  return result;
}

export function replaceClip(
  snapshot:WorkingTimelineSnapshot,
  position:number,
  replacement:{
    assetVersionId:string;
    assetNodeId:string;
    availableDurationMs:number|null;
  }
):WorkingTimelineSnapshot{
  const result=cloneSnapshot(snapshot);
  const item=result.items[position];
  if(!item) throw new Error("Selected refinement item does not exist.");
  item.assetVersionId=replacement.assetVersionId;
  item.assetNodeId=replacement.assetNodeId;
  item.availableDurationMs=replacement.availableDurationMs;
  item.manualOverride=true;

  validateWorkingTimeline(result);
  return result;
}

export function updateTransition(
  snapshot:WorkingTimelineSnapshot,
  input:{
    fromPosition:number;
    kind:string;
    durationMs:number;
    note:string;
  }
):WorkingTimelineSnapshot{
  if(
    input.fromPosition<0||
    input.fromPosition>=snapshot.items.length-1
  ){
    throw new Error("Selected refinement transition does not exist.");
  }

  const transitions=snapshot.transitions
    .filter(item=>item.fromPosition!==input.fromPosition)
    .map(item=>({...item}));
  transitions.push({
    fromPosition:input.fromPosition,
    toPosition:input.fromPosition+1,
    kind:input.kind.trim().toUpperCase().replace(/\s+/g,"_"),
    durationMs:input.durationMs,
    parameters:{
      origin:"MANUAL",
      note:input.note
    }
  });
  transitions.sort((a,b)=>a.fromPosition-b.fromPosition);

  const result={...cloneSnapshot(snapshot),transitions};
  validateWorkingTimeline(result);
  return result;
}

/** Sets (or resets with null) the crop/reframe of one shot. */
export function setItemFraming(
  snapshot:WorkingTimelineSnapshot,
  position:number,
  framing:ItemFraming|null
):WorkingTimelineSnapshot{
  const result=cloneSnapshot(snapshot);
  const item=result.items[position];
  if(!item) throw new Error("Selected refinement item does not exist.");
  const parameters=item.parameters&&typeof item.parameters==="object"&&!Array.isArray(item.parameters)
    ?{...(item.parameters as Record<string,unknown>)}
    :{};
  if(!framing||isDefaultFraming(framing)) delete parameters.framing;
  else parameters.framing={...framing};
  item.parameters=parameters;
  item.manualOverride=true;
  validateWorkingTimeline(result);
  return result;
}

/** Replaces every overlay of one kind (titles or captions). */
export function replaceOverlays(
  snapshot:WorkingTimelineSnapshot,
  kind:OverlayKind,
  overlays:readonly Omit<TimelineOverlay,"kind">[]
):WorkingTimelineSnapshot{
  const result=cloneSnapshot(snapshot);
  const kept=(result.overlays??[]).filter(item=>item.kind!==kind);
  const next=[
    ...kept,
    ...overlays.map(item=>({...item,kind,text:item.text.trim()}))
  ].sort((a,b)=>a.startMs-b.startMs||(a.kind===b.kind?0:a.kind==="title"?-1:1));
  if(next.length) result.overlays=next;
  else delete result.overlays;
  validateWorkingTimeline(result);
  return result;
}

function srtTime(value:string){
  const match=value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if(!match) throw new Error("Invalid caption timestamp: "+value.trim());
  const [,h,m,s,ms]=match;
  return ((Number(h)*60+Number(m))*60+Number(s))*1000+Number(ms!.padEnd(3,"0"));
}

/** Parses SubRip (.srt) text into bottom-placed caption cues. */
export function parseSrtCaptions(source:string):Omit<TimelineOverlay,"kind">[]{
  const blocks=source.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").split(/\n\s*\n/);
  const cues:Omit<TimelineOverlay,"kind">[]=[];
  for(const block of blocks){
    const lines=block.split("\n").map(line=>line.trim()).filter(Boolean);
    if(!lines.length) continue;
    const timingIndex=lines.findIndex(line=>line.includes("-->"));
    if(timingIndex<0) throw new Error("Caption block is missing a --> timing line.");
    const [start,end]=lines[timingIndex]!.split("-->");
    const text=lines.slice(timingIndex+1).join(" ").replace(/<[^>]*>/g,"").trim();
    if(!text) continue;
    cues.push({
      text:text.slice(0,MAX_OVERLAY_TEXT),
      startMs:srtTime(start!),
      endMs:srtTime(end!.trim().split(/\s+/)[0]!),
      placement:"bottom"
    });
  }
  return cues;
}
