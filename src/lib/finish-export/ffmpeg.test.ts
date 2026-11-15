import { describe,expect,it } from "vitest";
import type { RenderManifest } from "./manifest";
import { buildFfmpegRenderCommand, framingFilter } from "./ffmpeg";

function manifest():RenderManifest{
  return {
    schemaVersion:1,
    projectVersionId:"project",
    sourceTimelineVersionId:"timeline",
    sourceTimelineNodeId:"timeline-node",
    audioMasterAssetVersionId:"audio",
    audioMasterNodeId:"audio-node",
    output:{
      width:1920,
      height:1080,
      frameRate:24,
      aspectRatio:"16:9",
      container:"mp4",
      videoCodec:"h264",
      audioCodec:"aac",
      pixelFormat:"yuv420p"
    },
    durationMs:2000,
    expectedFrameCount:48,
    items:[
      {
        position:0,
        shotVersionId:"shot-0",
        clipAssetVersionId:"clip-0",
        clipNodeId:"clip-node-0",
        timelineStartMs:0,
        timelineEndMs:1000,
        sourceStartMs:0,
        sourceEndMs:1000
      },
      {
        position:1,
        shotVersionId:"shot-1",
        clipAssetVersionId:"clip-1",
        clipNodeId:"clip-node-1",
        timelineStartMs:1000,
        timelineEndMs:2000,
        sourceStartMs:0,
        sourceEndMs:1000
      }
    ],
    transitions:[{
      fromPosition:0,
      toPosition:1,
      kind:"DISSOLVE",
      durationMs:400,
      parameters:{}
    }]
  };
}

describe("FFmpeg master render command",()=>{
  it("uses only the outgoing transition tail as extra source media",()=>{
    const command=buildFfmpegRenderCommand({
      executable:"ffmpeg",
      manifest:manifest(),
      clipPaths:["/tmp/0.mp4","/tmp/1.mp4"],
      audioPath:"/tmp/audio.wav",
      outputPath:"/tmp/master.mp4"
    });
    expect(command.filterComplex).toContain(
      "[0:v]trim=start=0:end=1.4"
    );
    expect(command.filterComplex).toContain(
      "[1:v]trim=start=0:end=1"
    );
  });

  it("places xfade at the exact locked cut boundary",()=>{
    const command=buildFfmpegRenderCommand({
      executable:"ffmpeg",
      manifest:manifest(),
      clipPaths:["0.mp4","1.mp4"],
      audioPath:"audio.wav",
      outputPath:"master.mp4"
    });
    expect(command.filterComplex).toContain(
      "xfade=transition=dissolve:duration=0.4:offset=1"
    );
  });

  it("uses concat for a zero-duration transition",()=>{
    const value=manifest();
    value.transitions[0]!.durationMs=0;
    const command=buildFfmpegRenderCommand({
      executable:"ffmpeg",
      manifest:value,
      clipPaths:["0.mp4","1.mp4"],
      audioPath:"audio.wav",
      outputPath:"master.mp4"
    });
    expect(command.filterComplex).toContain("concat=n=2:v=1:a=0");
    expect(command.filterComplex).not.toContain("xfade=");
  });

  it("maps normalized video and trimmed immutable audio to H.264/AAC MP4",()=>{
    const command=buildFfmpegRenderCommand({
      executable:"/usr/bin/ffmpeg",
      manifest:manifest(),
      clipPaths:["0.mp4","1.mp4"],
      audioPath:"audio.wav",
      outputPath:"master.mp4"
    });
    expect(command.executable).toBe("/usr/bin/ffmpeg");
    expect(command.args).toContain("libx264");
    expect(command.args).toContain("aac");
    expect(command.args).toContain("+faststart");
    expect(command.filterComplex).toContain(
      "[2:a]atrim=start=0:end=2,asetpts=PTS-STARTPTS[aout]"
    );
  });

  it("requires one local clip path per manifest item",()=>{
    expect(()=>buildFfmpegRenderCommand({
      executable:"ffmpeg",
      manifest:manifest(),
      clipPaths:["0.mp4"],
      audioPath:"audio.wav",
      outputPath:"master.mp4"
    })).toThrow(/one local clip path/);
  });

  it("keeps the default fit (letterbox) chain when no framing is set",()=>{
    const command=buildFfmpegRenderCommand({executable:"ffmpeg",manifest:manifest(),clipPaths:["0.mp4","1.mp4"],audioPath:"a.wav",outputPath:"m.mp4"});
    expect(command.filterComplex).toContain("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1");
  });

  it("crops and reframes a shot with fill, zoom and focus",()=>{
    const value=manifest();
    value.items[1]!.framing={mode:"fill",zoom:1.5,focusX:0.25,focusY:1};
    const command=buildFfmpegRenderCommand({executable:"ffmpeg",manifest:value,clipPaths:["0.mp4","1.mp4"],audioPath:"a.wav",outputPath:"m.mp4"});
    expect(command.filterComplex).toContain("[1:v]trim=start=0:end=1,setpts=PTS-STARTPTS,scale=2880:1620:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)*0.25:(ih-1080)*1,setsar=1");
    expect(framingFilter({width:160,height:90},{mode:"fill",zoom:1.01,focusX:0.5,focusY:0.5})).toContain("scale=162:90:");
  });

  it("burns titles and captions from text files with timed enable windows",()=>{
    const value=manifest();
    value.overlays=[
      {kind:"title",text:"Title: it's 100%",startMs:0,endMs:1500,placement:"center"},
      {kind:"caption",text:"line",startMs:500,endMs:1000,placement:"bottom"}
    ];
    const command=buildFfmpegRenderCommand({executable:"ffmpeg",manifest:value,clipPaths:["0.mp4","1.mp4"],audioPath:"a.wav",outputPath:"m.mp4",
      overlayTextPaths:["/tmp/r/overlay-0.txt","/tmp/r/overlay-1.txt"],fontFile:"/fonts/Sans.ttf"});
    expect(command.filterComplex).toContain("[mix1]drawtext=fontfile='/fonts/Sans.ttf':textfile='/tmp/r/overlay-0.txt':expansion=none:fontsize=90");
    expect(command.filterComplex).toContain("y=(h-text_h)/2:enable='between(t,0,1.5)'[ov0]");
    expect(command.filterComplex).toContain("[ov0]drawtext=");
    expect(command.filterComplex).toContain(":box=1:");
    expect(command.filterComplex).toContain("enable='between(t,0.5,1)'[ov1]");
    expect(command.filterComplex).not.toContain("it's");
    expect(command.args).toContain("[ov1]");
  });

  it("refuses overlays without a font or matching text files",()=>{
    const value=manifest();
    value.overlays=[{kind:"title",text:"T",startMs:0,endMs:500,placement:"top"}];
    const base={executable:"ffmpeg",manifest:value,clipPaths:["0.mp4","1.mp4"],audioPath:"a.wav",outputPath:"m.mp4"};
    expect(()=>buildFfmpegRenderCommand({...base,overlayTextPaths:["t.txt"]})).toThrow(/font/);
    expect(()=>buildFfmpegRenderCommand({...base,fontFile:"f.ttf",overlayTextPaths:[]})).toThrow(/one text file/);
    expect(()=>buildFfmpegRenderCommand({...base,fontFile:"f'.ttf",overlayTextPaths:["t.txt"]})).toThrow(/quotes/);
  });
});
