"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { animaticFrameAt, type AnimaticFrame, type AnimaticPlan } from "@/lib/animatic/compiler";

function clock(ms:number){
  const total=Math.max(0,Math.floor(ms/1000));
  return Math.floor(total/60)+":"+String(total%60).padStart(2,"0");
}

export function AnimaticEditor(props:{
  projectId:string;
  audioUrl:string|null;
  sourceReady:boolean;
  sourceError:string|null;
  plan:AnimaticPlan|null;
  stillUrls:Record<string,string>;
  wizardRevision:number;
  wizardStatus:string;
  wizardLocked:boolean;
  reviewedCurrent:boolean;
}){
  const router=useRouter();
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const [frame,setFrame]=useState<AnimaticFrame|null>(
    props.plan?animaticFrameAt(props.plan,0):null
  );
  const [timeMs,setTimeMs]=useState(0);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const plan=props.plan;

  // Follow the audio clock every animation frame so stills stay sample-synced.
  useEffect(()=>{
    if(!plan) return;
    let handle=0;
    const tick=()=>{
      const audio=audioRef.current;
      const ms=audio?audio.currentTime*1000:0;
      setTimeMs(ms);
      setFrame(animaticFrameAt(plan,ms));
      handle=window.requestAnimationFrame(tick);
    };
    handle=window.requestAnimationFrame(tick);
    return ()=>window.cancelAnimationFrame(handle);
  },[plan]);

  if(!plan){
    return (
      <div className="firstCutEditor">
        <p className="eyebrow">Animatic</p>
        <p className="dashboardNote">
          {props.sourceError??"Lock Shot Specifications to build the animatic."}
        </p>
      </div>
    );
  }

  const current=frame?plan.items[frame.position]:undefined;
  const incoming=frame?.incomingPosition!=null?plan.items[frame.incomingPosition]:undefined;

  function still(item:typeof current,opacity:number){
    if(!item) return null;
    const url=item.imageAssetVersionId?props.stillUrls[item.imageAssetVersionId]:undefined;
    const style={position:"absolute" as const,inset:0,width:"100%",height:"100%",objectFit:"contain" as const,opacity};
    return url?(
      // Signed private storage URL; see initial-frames-editor for why <img> is used.
      // eslint-disable-next-line @next/next/no-img-element
      <img key={item.position} src={url} alt={item.label??"Shot "+(item.position+1)} style={style}/>
    ):(
      <div key={item.position} className="initialFramePlaceholder" style={{...style,display:"grid",placeItems:"center"}}>
        {(item.label??"Shot "+(item.position+1))+" — still missing"}
      </div>
    );
  }

  function seek(ms:number){
    if(audioRef.current) audioRef.current.currentTime=ms/1000;
  }

  async function complete(){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch("/api/projects/"+props.projectId+"/animatic",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"complete",expectedWizardRevision:props.wizardRevision})
      });
      const body=await response.json() as {error?:string};
      if(!response.ok) throw new Error(body.error??"Animatic review could not be recorded.");
      setMessage("Animatic review recorded.");
      router.refresh();
    }catch(error){
      setMessage(error instanceof Error?error.message:"Animatic review could not be recorded.");
    }finally{
      setBusy(false);
    }
  }

  return (
    <div className="firstCutEditor">
      <p className="eyebrow">Animatic · {plan.items.length} shots · {clock(plan.durationMs)}</p>
      <p className="dashboardNote">
        Approved Initial Frames held for each shot&apos;s locked storyboard timing, played against the
        audio master with the same cuts and transition timing the First Cut will use. Nothing is
        rendered on the server.
      </p>
      {plan.missingStillCount>0?(
        <p className="warningBanner">
          {plan.missingStillCount} shot(s) have no approved still yet and show a placeholder.
        </p>
      ):null}
      <div className="firstCutMonitor" style={{position:"relative",aspectRatio:"16 / 9",background:"#000",overflow:"hidden"}}>
        {still(current,1)}
        {incoming?still(incoming,frame?.incomingOpacity??0):null}
      </div>
      <p className="formMessage" aria-live="polite">
        {current?(current.label??"Shot "+(current.position+1)):""} · {clock(timeMs)} / {clock(plan.durationMs)}
      </p>
      {props.audioUrl?(
        <audio ref={audioRef} className="audioPlayer" controls preload="metadata" src={props.audioUrl}/>
      ):(
        <p className="dashboardNote">The audio master is not ready; the animatic cannot play in sync.</p>
      )}
      <ol className="firstCutTransitionList">
        {plan.items.map(item=>(
          <li key={item.position}>
            <button type="button" className="secondaryButton" onClick={()=>seek(item.timelineStartMs)}>
              {clock(item.timelineStartMs)} · {item.label??"Shot "+(item.position+1)}
              {item.imageAssetVersionId?"":" (missing still)"}
            </button>
          </li>
        ))}
      </ol>
      {!props.wizardLocked?(
        <button
          type="button"
          className="primaryButton"
          disabled={busy||plan.missingStillCount>0||props.reviewedCurrent}
          onClick={complete}
        >
          {props.reviewedCurrent?"Animatic reviewed":"Mark animatic reviewed"}
        </button>
      ):null}
      {message?<p className="formMessage">{message}</p>:null}
    </div>
  );
}
