import { describe,expect,it } from "vitest";
import {
  parseItemFraming,
  parseSrtCaptions,
  replaceClip,
  replaceOverlays,
  retimeBoundary,
  setItemFraming,
  updateTransition,
  validateWorkingTimeline,
  type WorkingTimelineSnapshot
} from "./timeline";

function snapshot():WorkingTimelineSnapshot{
  const item=(position:number)=>({
    position,
    shotVersionId:"shot-"+position,
    assetVersionId:"clip-"+position,
    assetNodeId:"node-"+position,
    timelineStartMs:position*1000,
    timelineEndMs:(position+1)*1000,
    sourceStartMs:0,
    sourceEndMs:1000,
    manualOverride:false,
    parameters:{prompt:"kept"},
    availableDurationMs:1800
  });
  return {items:[item(0),item(1)],transitions:[{fromPosition:0,toPosition:1,kind:"CUT",durationMs:0,parameters:{}}]};
}

describe("shot crop/reframe",()=>{
  it("stores validated framing without losing other parameters",()=>{
    const next=setItemFraming(snapshot(),1,{mode:"fill",zoom:1.5,focusX:0.25,focusY:0.75});
    expect(next.items[1]!.parameters).toEqual({prompt:"kept",framing:{mode:"fill",zoom:1.5,focusX:0.25,focusY:0.75}});
    expect(next.items[1]!.manualOverride).toBe(true);
    expect(parseItemFraming(next.items[1]!.parameters)).toEqual({mode:"fill",zoom:1.5,focusX:0.25,focusY:0.75});
    expect(parseItemFraming(next.items[0]!.parameters)).toBeNull();
  });

  it("removes framing when reset to the default fit",()=>{
    const framed=setItemFraming(snapshot(),0,{mode:"fill",zoom:2,focusX:0.5,focusY:0.5});
    const reset=setItemFraming(framed,0,null);
    expect(reset.items[0]!.parameters).toEqual({prompt:"kept"});
  });

  it("rejects out-of-range framing",()=>{
    expect(()=>setItemFraming(snapshot(),0,{mode:"fill",zoom:5,focusX:0.5,focusY:0.5})).toThrow(/framing/);
    expect(()=>setItemFraming(snapshot(),0,{mode:"fill",zoom:1,focusX:-1,focusY:0.5})).toThrow(/framing/);
    expect(()=>setItemFraming(snapshot(),9,null)).toThrow(/does not exist/);
  });
});

describe("titles and captions",()=>{
  it("replaces one overlay kind and keeps the other",()=>{
    let next=replaceOverlays(snapshot(),"title",[{text:"  Song Title ",startMs:0,endMs:1500,placement:"center"}]);
    next=replaceOverlays(next,"caption",[{text:"first line",startMs:200,endMs:900,placement:"bottom"}]);
    expect(next.overlays).toEqual([
      {kind:"title",text:"Song Title",startMs:0,endMs:1500,placement:"center"},
      {kind:"caption",text:"first line",startMs:200,endMs:900,placement:"bottom"}
    ]);
    const withoutCaptions=replaceOverlays(next,"caption",[]);
    expect(withoutCaptions.overlays?.map(item=>item.kind)).toEqual(["title"]);
    expect(replaceOverlays(withoutCaptions,"title",[]).overlays).toBeUndefined();
  });

  it("validates overlay timing, text, and caption overlap",()=>{
    expect(()=>replaceOverlays(snapshot(),"title",[{text:"x",startMs:0,endMs:2500,placement:"top"}])).toThrow(/inside the timeline/);
    expect(()=>replaceOverlays(snapshot(),"title",[{text:"   ",startMs:0,endMs:500,placement:"top"}])).toThrow(/printable/);
    expect(()=>replaceOverlays(snapshot(),"title",[{text:"bad\u0007",startMs:0,endMs:500,placement:"top"}])).toThrow(/printable/);
    expect(()=>replaceOverlays(snapshot(),"caption",[
      {text:"a",startMs:0,endMs:600,placement:"bottom"},
      {text:"b",startMs:500,endMs:900,placement:"bottom"}
    ])).toThrow(/overlap/);
  });

  it("survives retime, clip replacement, and transition edits",()=>{
    const titled=replaceOverlays(snapshot(),"title",[{text:"Title",startMs:0,endMs:800,placement:"top"}]);
    const edited=updateTransition(
      replaceClip(retimeBoundary(titled,0,1200),1,{assetVersionId:"clip-x",assetNodeId:"node-x",availableDurationMs:1800}),
      {fromPosition:0,kind:"dissolve",durationMs:200,note:""}
    );
    expect(edited.overlays).toEqual(titled.overlays);
    expect(()=>validateWorkingTimeline(edited)).not.toThrow();
  });

  it("parses SubRip captions",()=>{
    const cues=parseSrtCaptions("﻿1\r\n00:00:00,250 --> 00:00:01,000\r\nHello <i>there</i>\r\nworld\r\n\r\n2\n00:00:01.5 --> 00:00:01.900 X1:0\nBye\n");
    expect(cues).toEqual([
      {text:"Hello there world",startMs:250,endMs:1000,placement:"bottom"},
      {text:"Bye",startMs:1500,endMs:1900,placement:"bottom"}
    ]);
    expect(()=>parseSrtCaptions("1\nnot a time\nhi")).toThrow(/-->/);
    expect(()=>replaceOverlays(snapshot(),"caption",parseSrtCaptions("1\n00:00:00,000 --> 00:00:01,000\nok"))).not.toThrow();
  });
});
