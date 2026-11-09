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

export function buildFfmpegRenderCommand(input:{
  executable:string;
  manifest:RenderManifest;
  clipPaths:string[];
  audioPath:string;
  outputPath:string;
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
      ",setpts=PTS-STARTPTS"+
      ",scale="+manifest.output.width+":"+manifest.output.height+
      ":force_original_aspect_ratio=decrease"+
      ",pad="+manifest.output.width+":"+manifest.output.height+
      ":(ow-iw)/2:(oh-ih)/2:black"+
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
    "-crf","18",
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
