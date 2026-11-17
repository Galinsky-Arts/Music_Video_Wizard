import type { RenderManifest } from "./manifest";

export interface FfmpegRenderCommand {
  executable:string;
  args:string[];
  filterComplex:string;
}

function seconds(ms:number){
  return (ms/1000)
    .toFixed(6)
    .replace(/0+$/,"")
    .replace(/\.$/,"");
}

function fpsValue(value:number){
  return Number.isInteger(value)?String(value):String(value);
}

function xfadeTransition(kind:string){
  switch(kind.trim().toUpperCase()){
    case "DISSOLVE":
    case "CROSS_DISSOLVE":
      return "dissolve";
    case "WIPE":
      return "wipeleft";
    case "WHIP":
      return "slideleft";
    case "FADE":
      return "fade";
    case "MORPH":
      return "fade";
    default:
      return "fade";
  }
}

function even(value:number){
  return Math.max(2,Math.round(value/2)*2);
}

/** Scale/crop chain for one shot; "fit" letterboxes, "fill" covers then crops. */
export function framingFilter(
  output:{width:number;height:number},
  framing:RenderManifest["items"][number]["framing"]
){
  const {width,height}=output;
  if(!framing||framing.mode==="fit"){
    return "scale="+width+":"+height+
      ":force_original_aspect_ratio=decrease"+
      ",pad="+width+":"+height+
      ":(ow-iw)/2:(oh-ih)/2:black";
  }
  const scaledWidth=even(width*framing.zoom);
  const scaledHeight=even(height*framing.zoom);
  return "scale="+scaledWidth+":"+scaledHeight+
    ":force_original_aspect_ratio=increase"+
    ",crop="+width+":"+height+
    ":(iw-"+width+")*"+framing.focusX+
    ":(ih-"+height+")*"+framing.focusY;
}

function quotedPath(path:string){
  if(/['\n\r]/.test(path)) throw new Error("FFmpeg overlay paths cannot contain quotes or newlines.");
  return "'"+path.replace(/\\/g,"/")+"'";
}

/** drawtext chain for titles/captions. Text is read from files (no escaping of user text). */
export function overlayFilters(input:{
  manifest:RenderManifest;
  inputLabel:string;
  textPaths:readonly string[];
  fontFile:string;
}){
  const overlays=input.manifest.overlays??[];
  if(input.textPaths.length!==overlays.length){
    throw new Error("FFmpeg overlay rendering requires one text file per overlay.");
  }
  const height=input.manifest.output.height;
  const filters:string[]=[];
  let label=input.inputLabel;
  overlays.forEach((overlay,index)=>{
    const caption=overlay.kind==="caption";
    const fontSize=Math.max(12,Math.round(height/(caption?22:12)));
    const margin=Math.round(height*0.06);
    const y=overlay.placement==="top"
      ?String(margin)
      :overlay.placement==="center"
        ?"(h-text_h)/2"
        :"h-text_h-"+margin;
    const next="ov"+index;
    filters.push(
      "["+label+"]drawtext=fontfile="+quotedPath(input.fontFile)+
      ":textfile="+quotedPath(input.textPaths[index]!)+
      ":expansion=none:fontsize="+fontSize+
      ":fontcolor=white:line_spacing="+Math.round(fontSize/4)+
      (caption
        ?":box=1:boxcolor=black@0.55:boxborderw="+Math.round(fontSize/3)
        :":borderw="+Math.max(1,Math.round(fontSize/18))+":bordercolor=black@0.85")+
      ":x=(w-text_w)/2:y="+y+
      ":enable='between(t,"+seconds(overlay.startMs)+","+seconds(overlay.endMs)+")'"+
      "["+next+"]"
    );
    label=next;
  });
  return {filters,outputLabel:label};
}

export function buildFfmpegRenderCommand(input:{
  executable:string;
  manifest:RenderManifest;
  clipPaths:string[];
  audioPath:string;
  outputPath:string;
  /** Required when the manifest has overlays: one UTF-8 text file per overlay. */
  overlayTextPaths?:string[];
  fontFile?:string|null;
}):FfmpegRenderCommand{
  const {manifest}=input;
  if(input.clipPaths.length!==manifest.items.length){
    throw new Error(
      "FFmpeg render command requires one local clip path per manifest item."
    );
  }

  const transitionByFrom=new Map(
    manifest.transitions.map(transition=>[
      transition.fromPosition,
      transition
    ])
  );
  const filters:string[]=[];

  for(const item of manifest.items){
    const outgoing=transitionByFrom.get(item.position);
    const tailMs=outgoing?.durationMs??0;
    const trimEndMs=item.sourceEndMs+tailMs;
    filters.push(
      "["+item.position+":v]"+
      "trim=start="+seconds(item.sourceStartMs)+
      ":end="+seconds(trimEndMs)+
      ",setpts=PTS-STARTPTS,"+
      framingFilter(manifest.output,item.framing)+
      ",setsar=1"+
      ",fps="+fpsValue(manifest.output.frameRate)+
      ",settb=AVTB"+
      ",format="+manifest.output.pixelFormat+
      "[v"+item.position+"]"
    );
  }

  let currentLabel="v0";
  for(let position=0;position<manifest.items.length-1;position++){
    const transition=transitionByFrom.get(position);
    const nextLabel="v"+String(position+1);
    const outputLabel="mix"+String(position+1);
    if(transition&&transition.durationMs>0){
      const offsetMs=manifest.items[position]!.timelineEndMs;
      filters.push(
        "["+currentLabel+"]["+nextLabel+"]"+
        "xfade=transition="+xfadeTransition(transition.kind)+
        ":duration="+seconds(transition.durationMs)+
        ":offset="+seconds(offsetMs)+
        "["+outputLabel+"]"
      );
    }else{
      filters.push(
        "["+currentLabel+"]["+nextLabel+"]"+
        "concat=n=2:v=1:a=0"+
        "["+outputLabel+"]"
      );
    }
    currentLabel=outputLabel;
  }

  if(manifest.overlays?.length){
    if(!input.fontFile){
      throw new Error("Rendering titles or captions requires an installed font file.");
    }
    const overlay=overlayFilters({
      manifest,
      inputLabel:currentLabel,
      textPaths:input.overlayTextPaths??[],
      fontFile:input.fontFile
    });
    filters.push(...overlay.filters);
    currentLabel=overlay.outputLabel;
  }

  const audioInputIndex=manifest.items.length;
  filters.push(
    "["+audioInputIndex+":a]"+
    "atrim=start=0:end="+seconds(manifest.durationMs)+
    ",asetpts=PTS-STARTPTS"+
    "[aout]"
  );

  const filterComplex=filters.join(";");
  const args:string[]=[
    "-nostdin",
    "-hide_banner",
    "-loglevel","error",
    "-progress","pipe:1"
  ];

  for(const path of input.clipPaths){
    args.push("-threads","1","-i",path);
  }
  args.push("-i",input.audioPath);
  args.push(
    "-filter_complex_threads","1",
    "-filter_complex",filterComplex,
    "-map","["+currentLabel+"]",
    "-map","[aout]",
    "-c:v","libx264",
    "-threads","1",
    "-preset","veryfast",
    "-crf",String(manifest.output.crf??18),
    "-pix_fmt",manifest.output.pixelFormat,
    "-r",fpsValue(manifest.output.frameRate),
    "-c:a","aac",
    "-b:a","320k",
    "-movflags","+faststart",
    "-t",seconds(manifest.durationMs),
    "-y",
    input.outputPath
  );

  return {
    executable:input.executable,
    args,
    filterComplex
  };
}
