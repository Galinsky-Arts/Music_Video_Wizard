"use client";

import { useEffect, useState } from "react";
import { parseItemFraming, parseSrtCaptions, type ItemFraming } from "@/lib/refinement/timeline";

export type FinishingOverlay={
  kind:"title"|"caption";
  text:string;
  startMs:number;
  endMs:number;
  placement:"top"|"center"|"bottom";
};

type FinishingItem={
  position:number;
  timelineStartMs:number;
  timelineEndMs:number;
  parameters:unknown;
};

type TitleDraft={text:string;start:string;end:string;placement:FinishingOverlay["placement"]};

function seconds(ms:number){
  return (ms/1000).toFixed(3);
}

function toMs(value:string){
  const number=Number(value);
  return Number.isFinite(number)?Math.round(number*1000):NaN;
}

function srtStamp(ms:number){
  const pad=(value:number,size=2)=>String(value).padStart(size,"0");
  return pad(Math.floor(ms/3600000))+":"+pad(Math.floor(ms/60000)%60)+":"+
    pad(Math.floor(ms/1000)%60)+","+pad(ms%1000,3);
}

function captionsToSrt(captions:FinishingOverlay[]){
  return captions.map((cue,index)=>
    String(index+1)+"\n"+srtStamp(cue.startMs)+" --> "+srtStamp(cue.endMs)+"\n"+cue.text
  ).join("\n\n");
}

/**
 * Finishing controls on the working timeline: per-shot crop/reframe, titles and
 * optional burned-in captions (SubRip). Every change creates a new working version.
 */
export function FinishingPanel(props:{
  items:FinishingItem[];
  overlays:FinishingOverlay[];
  durationMs:number;
  disabled:boolean;
  onMutate:(body:Record<string,unknown>,success:string)=>Promise<void>;
}){
  const [framingDrafts,setFramingDrafts]=useState<Record<number,ItemFraming>>({});
  const [titles,setTitles]=useState<TitleDraft[]>([]);
  const [srt,setSrt]=useState("");
  const [error,setError]=useState<string|null>(null);

  useEffect(()=>{
    const framings:Record<number,ItemFraming>={};
    for(const item of props.items){
      framings[item.position]=parseItemFraming(item.parameters)??{mode:"fit",zoom:1,focusX:0.5,focusY:0.5};
    }
    setFramingDrafts(framings);
    setTitles(props.overlays.filter(item=>item.kind==="title").map(item=>({
      text:item.text,
      start:seconds(item.startMs),
      end:seconds(item.endMs),
      placement:item.placement
    })));
    setSrt(captionsToSrt(props.overlays.filter(item=>item.kind==="caption")));
  },[props.items,props.overlays]);

  function updateFraming(position:number,patch:Partial<ItemFraming>){
    setFramingDrafts(current=>({...current,[position]:{...current[position]!,...patch}}));
  }

  async function saveFraming(position:number){
    const framing=framingDrafts[position];
    if(!framing) return;
    await props.onMutate({action:"framing",position,framing},"Shot "+(position+1)+" reframed.");
  }

  async function saveTitles(){
    setError(null);
    const overlays=titles.map(item=>({
      text:item.text,
      startMs:toMs(item.start),
      endMs:toMs(item.end),
      placement:item.placement
    }));
    if(overlays.some(item=>!item.text.trim()||!Number.isFinite(item.startMs)||!Number.isFinite(item.endMs))){
      setError("Every title needs text and numeric start/end seconds.");
      return;
    }
    await props.onMutate({action:"overlays",kind:"title",overlays},"Titles saved.");
  }

  async function saveCaptions(clear=false){
    setError(null);
    let overlays:ReturnType<typeof parseSrtCaptions>=[];
    if(!clear){
      try{
        overlays=parseSrtCaptions(srt);
      }catch(parseError){
        setError(parseError instanceof Error?parseError.message:"Captions could not be parsed.");
        return;
      }
    }
    await props.onMutate(
      {action:"overlays",kind:"caption",overlays},
      clear?"Captions removed.":overlays.length+" caption(s) saved."
    );
  }

  return (
    <section className="refinementHistory" aria-labelledby="finishing-heading">
      <div>
        <p className="eyebrow">Finishing</p>
        <h3 id="finishing-heading">Crop/reframe, titles and captions</h3>
        <p className="dashboardNote">
          Burned into the final master by FFmpeg. &quot;Fit&quot; keeps the whole frame
          (letterbox); &quot;Fill&quot; covers the frame and crops, with optional zoom and focus.
        </p>
      </div>

      <div className="refinementHistoryList">
        {props.items.map(item=>{
          const framing=framingDrafts[item.position];
          if(!framing) return null;
          const id="framing-"+item.position;
          return (
            <article key={item.position}>
              <strong>Shot {item.position+1}</strong>
              <span>{seconds(item.timelineStartMs)}s – {seconds(item.timelineEndMs)}s</span>
              <label htmlFor={id+"-mode"}>Framing</label>
              <select
                id={id+"-mode"}
                value={framing.mode}
                disabled={props.disabled}
                onChange={event=>updateFraming(item.position,{mode:event.target.value as ItemFraming["mode"]})}
              >
                <option value="fit">Fit (letterbox)</option>
                <option value="fill">Fill (crop)</option>
              </select>
              {framing.mode==="fill"?(
                <>
                  <label htmlFor={id+"-zoom"}>Zoom {framing.zoom.toFixed(2)}×</label>
                  <input id={id+"-zoom"} type="range" min={1} max={4} step={0.05} value={framing.zoom}
                    disabled={props.disabled}
                    onChange={event=>updateFraming(item.position,{zoom:Number(event.target.value)})}/>
                  <label htmlFor={id+"-x"}>Horizontal focus {Math.round(framing.focusX*100)}%</label>
                  <input id={id+"-x"} type="range" min={0} max={1} step={0.01} value={framing.focusX}
                    disabled={props.disabled}
                    onChange={event=>updateFraming(item.position,{focusX:Number(event.target.value)})}/>
                  <label htmlFor={id+"-y"}>Vertical focus {Math.round(framing.focusY*100)}%</label>
                  <input id={id+"-y"} type="range" min={0} max={1} step={0.01} value={framing.focusY}
                    disabled={props.disabled}
                    onChange={event=>updateFraming(item.position,{focusY:Number(event.target.value)})}/>
                </>
              ):null}
              <button type="button" className="secondaryButton" disabled={props.disabled}
                onClick={()=>saveFraming(item.position)}>
                Apply framing
              </button>
            </article>
          );
        })}
      </div>

      <div>
        <p className="eyebrow">Titles</p>
        {titles.map((title,index)=>(
          <div key={index} className="creativeLanguageActions">
            <input aria-label={"Title "+(index+1)+" text"} value={title.text} maxLength={200} disabled={props.disabled}
              onChange={event=>setTitles(current=>current.map((item,i)=>i===index?{...item,text:event.target.value}:item))}/>
            <input aria-label={"Title "+(index+1)+" start seconds"} inputMode="decimal" value={title.start} disabled={props.disabled}
              onChange={event=>setTitles(current=>current.map((item,i)=>i===index?{...item,start:event.target.value}:item))}/>
            <input aria-label={"Title "+(index+1)+" end seconds"} inputMode="decimal" value={title.end} disabled={props.disabled}
              onChange={event=>setTitles(current=>current.map((item,i)=>i===index?{...item,end:event.target.value}:item))}/>
            <select aria-label={"Title "+(index+1)+" placement"} value={title.placement} disabled={props.disabled}
              onChange={event=>setTitles(current=>current.map((item,i)=>i===index?{...item,placement:event.target.value as TitleDraft["placement"]}:item))}>
              <option value="top">Top</option>
              <option value="center">Center</option>
              <option value="bottom">Bottom</option>
            </select>
            <button type="button" className="secondaryButton" disabled={props.disabled}
              onClick={()=>setTitles(current=>current.filter((_,i)=>i!==index))}>
              Remove
            </button>
          </div>
        ))}
        <div className="creativeLanguageActions">
          <button type="button" className="secondaryButton" disabled={props.disabled||titles.length>=20}
            onClick={()=>setTitles(current=>[...current,{text:"",start:"0.000",end:seconds(Math.min(4000,props.durationMs)),placement:"center"}])}>
            Add title
          </button>
          <button type="button" className="primaryButton" disabled={props.disabled} onClick={saveTitles}>
            Save titles
          </button>
        </div>
      </div>

      <div>
        <p className="eyebrow">Captions (optional)</p>
        <label htmlFor="finishing-srt" className="dashboardNote">
          Paste SubRip (.srt) cues; times are relative to the start of the song.
        </label>
        <textarea id="finishing-srt" rows={6} value={srt} disabled={props.disabled}
          onChange={event=>setSrt(event.target.value)}
          placeholder={"1\n00:00:05,000 --> 00:00:08,000\nFirst lyric line"}/>
        <div className="creativeLanguageActions">
          <button type="button" className="primaryButton" disabled={props.disabled||!srt.trim()} onClick={()=>saveCaptions()}>
            Save captions
          </button>
          <button type="button" className="secondaryButton"
            disabled={props.disabled||!props.overlays.some(item=>item.kind==="caption")}
            onClick={()=>saveCaptions(true)}>
            Remove captions
          </button>
        </div>
      </div>
      {error?<p className="formMessage" role="alert">{error}</p>:null}
    </section>
  );
}
