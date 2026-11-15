"use client";

import { useEffect, useState } from "react";
import { useLatest } from "./use-latest";
import { useRouter } from "next/navigation";

type Passage={
  title:string;
  startMs:number;
  endMs:number;
  treatmentSectionIndexes:number[];
  musicAnchorIds:string[];
  dramaticPurpose:string;
  pictureState:string;
  narrativeState:string;
  characterState:string;
  performanceMode:string;
  worldState:string;
  motifState:string;
  creativeLanguageApplication:string;
  cameraAndMotionIntent:string;
  editingRhythm:string;
  transitionIn:string;
  transitionOut:string;
  visualIntensity:number;
};

type Document={
  title:string;
  governingStrategy:string;
  visualEscalation:string;
  narrativeDistribution:string;
  performanceDistribution:string;
  transitionStrategy:string;
  endingStrategy:string;
  passages:Passage[];
};

type SourceContext={
  treatmentTitle:string;
  treatmentSections:Array<{index:number;title:string;startMs:number;endMs:number}>;
  creativeLanguageTitle:string;
  creativeLanguageIdea:string;
  musicMap:{
    durationMs:number;
    tempoBpm:number|null;
    meterNumerator:number;
    meterDenominator:number;
    anchors:Array<{id:string;kind:string;label:string;startMs:number;endMs:number|null}>;
  };
};

type VersionView={
  id:string;
  versionNumber:number;
  lifecycle:string;
  revision:number;
  sourceTreatmentVersionId:string;
  sourceTreatmentVersionNumber:number;
  sourceCreativeLanguageVersionId:string;
  sourceCreativeLanguageVersionNumber:number;
  sourceMusicMapVersionId:string;
  sourceMusicMapVersionNumber:number;
  document:Document;
  sourceContext:SourceContext;
  generationJobId:string|null;
};

type JobView={
  id:string;
  status:string;
  progressPercent:number;
  progressMessage:string|null;
  errorMessage:string|null;
}|null;

type ImpactWarning={stepKey:string;title:string;locked:boolean;status?:string};

const TOP_FIELDS:Array<[keyof Omit<Document,"passages">,string]>=[
  ["title","Plan title"],
  ["governingStrategy","Governing strategy"],
  ["visualEscalation","Visual escalation"],
  ["narrativeDistribution","Narrative distribution"],
  ["performanceDistribution","Performance distribution"],
  ["transitionStrategy","Transition strategy"],
  ["endingStrategy","Ending strategy"]
];

const PASSAGE_FIELDS:Array<[keyof Pick<Passage,
  "dramaticPurpose"|"pictureState"|"narrativeState"|"characterState"|"performanceMode"|"worldState"|"motifState"|"creativeLanguageApplication"|"cameraAndMotionIntent"|"editingRhythm"|"transitionIn"|"transitionOut"
>,string]>=[
  ["dramaticPurpose","Dramatic purpose"],
  ["pictureState","Picture state"],
  ["narrativeState","Narrative state"],
  ["characterState","Character state"],
  ["performanceMode","Performance mode"],
  ["worldState","World state"],
  ["motifState","Motif state"],
  ["creativeLanguageApplication","Creative Language application"],
  ["cameraAndMotionIntent","Camera & motion intent"],
  ["editingRhythm","Editing rhythm"],
  ["transitionIn","Transition in"],
  ["transitionOut","Transition out"]
];

function formatTime(ms:number){
  const total=Math.max(0,Math.round(ms/1000));
  return Math.floor(total/60)+":"+String(total%60).padStart(2,"0");
}

function emptyPassage(durationMs:number):Passage{
  return {
    title:"",startMs:0,endMs:durationMs,treatmentSectionIndexes:[],musicAnchorIds:[],
    dramaticPurpose:"",pictureState:"",narrativeState:"",characterState:"",
    performanceMode:"",worldState:"",motifState:"",creativeLanguageApplication:"",
    cameraAndMotionIntent:"",editingRhythm:"",transitionIn:"",transitionOut:"",
    visualIntensity:50
  };
}

export function SongPicturePlanEditor(props:{
  projectId:string;
  sourceReady:boolean;
  needsRebase:boolean;
  initialVersion:VersionView|null;
  recentJob:JobView;
  providerAvailable:boolean;
  wizardStatus:string;
  wizardLocked:boolean;
  downstreamImpact:ImpactWarning[];
}){
  const router=useRouter();
  const [version,setVersion]=useState<VersionView|null>(props.initialVersion);
  const [document,setDocument]=useState<Document|null>(props.initialVersion?.document??null);
  const [job,setJob]=useState<JobView>(props.recentJob);
  const [status,setStatus]=useState(props.wizardStatus);
  const [locked,setLocked]=useState(props.wizardLocked);
  const [direction,setDirection]=useState("");
  const [busy,setBusy]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const [impact,setImpact]=useState(props.downstreamImpact);

  const active=job?.status==="QUEUED"||job?.status==="RUNNING";
  const disabled=busy||active||locked||version?.lifecycle==="LOCKED";

  async function refreshState(){
    const response=await fetch(`/api/projects/${props.projectId}/song-picture-plan`,{cache:"no-store"});
    if(!response.ok)return;
    const state=await response.json() as {latest:VersionView|null;recentJob:JobView};
    if(state.latest){setVersion(state.latest);setDocument(state.latest.document);setDirty(false);}
    setJob(state.recentJob);
  }

  const refreshStateRef=useLatest(refreshState);
  useEffect(()=>{
    if(!active||!job)return;
    const timer=window.setInterval(async()=>{
      const response=await fetch("/api/jobs/"+job.id,{cache:"no-store"});
      if(!response.ok)return;
      const next=await response.json() as NonNullable<JobView>;
      setJob(next);
      if(["SUCCEEDED","FAILED","CANCELLED"].includes(next.status)){
        window.clearInterval(timer);
        await refreshStateRef.current();
        setMessage(next.status==="SUCCEEDED"?"Song-to-Picture Plan generated. Review and refine it before completion.":next.errorMessage??"Song-to-Picture generation did not complete.");
        router.refresh();
      }
    },2000);
    return()=>window.clearInterval(timer);
  },[active,job,router, refreshStateRef]);

  async function initialize(){
    setBusy(true);setMessage(null);
    try{
      const response=await fetch(`/api/projects/${props.projectId}/song-picture-plan`,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"initialize"})
      });
      const result=await response.json() as VersionView&{error?:string};
      if(!response.ok||!result.id){setMessage(result.error??"Song-to-Picture Plan could not be initialized.");return;}
      setVersion(result);setDocument(result.document);setStatus("IN_PROGRESS");setDirty(false);
      setMessage("Song-to-Picture Plan v"+result.versionNumber+" created from locked Treatment, Creative Language, and Music Map.");
      router.refresh();
    }finally{setBusy(false);}
  }

  async function save(){
    if(!version||!document)return;
    setBusy(true);setMessage(null);
    try{
      const response=await fetch(`/api/projects/${props.projectId}/song-picture-plan`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"save",songPicturePlanVersionId:version.id,expectedRevision:version.revision,document})
      });
      const result=await response.json() as {version?:VersionView;impactWarnings?:ImpactWarning[];error?:string};
      if(!response.ok||!result.version){setMessage(result.error??"Song-to-Picture Plan could not be saved.");return;}
      setVersion(result.version);setDocument(result.version.document);setDirty(false);setStatus("IN_PROGRESS");
      if(result.impactWarnings?.length)setImpact(result.impactWarnings);
      setMessage("Song-to-Picture Plan saved.");
    }finally{setBusy(false);}
  }

  async function generate(){
    if(!version)return;
    setBusy(true);setMessage(null);
    try{
      const response=await fetch(`/api/projects/${props.projectId}/song-picture-plan/generate`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({songPicturePlanVersionId:version.id,expectedRevision:version.revision,direction})
      });
      const result=await response.json() as {jobId?:string;status?:string;error?:string};
      if(!response.ok||!result.jobId){setMessage(result.error??"Song-to-Picture generation could not be queued.");return;}
      setJob({id:result.jobId,status:result.status??"QUEUED",progressPercent:0,progressMessage:"Queued.",errorMessage:null});
    }finally{setBusy(false);}
  }

  async function transition(action:"complete"|"reopen"|"lock"){
    if(!version)return;
    setBusy(true);setMessage(null);
    try{
      const response=await fetch(`/api/projects/${props.projectId}/song-picture-plan`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({action,songPicturePlanVersionId:version.id,expectedRevision:version.revision})
      });
      const result=await response.json() as {version?:VersionView;impactWarnings?:ImpactWarning[];error?:string};
      if(!response.ok||!result.version){setMessage(result.error??"Song-to-Picture transition failed.");return;}
      setVersion(result.version);setDocument(result.version.document);
      if(result.impactWarnings?.length)setImpact(result.impactWarnings);
      if(action==="complete")setStatus("COMPLETED");
      if(action==="reopen")setStatus("IN_PROGRESS");
      if(action==="lock")setLocked(true);
      setMessage(action==="lock"?"Song-to-Picture Plan locked.":action==="complete"?"Song-to-Picture Plan completed.":"Song-to-Picture Plan reopened.");
      router.refresh();
    }finally{setBusy(false);}
  }

  function setTop(key:keyof Omit<Document,"passages">,value:string){
    if(!document)return;
    setDocument({...document,[key]:value});setDirty(true);
  }

  function updatePassage(index:number,patch:Partial<Passage>){
    if(!document)return;
    setDocument({...document,passages:document.passages.map((p,i)=>i===index?{...p,...patch}:p)});
    setDirty(true);
  }

  if(!props.sourceReady){
    return <div className="songPictureEmpty"><h2>Song-to-Picture Plan is waiting for locked sources</h2><p>Lock the current Treatment and Creative Language, with their approved locked Music Map, before mapping pictures across the song.</p></div>;
  }

  if(!version||!document){
    return <div className="songPictureEmpty">
      <p className="eyebrow">PR 17 · Song-to-Picture Plan</p>
      <h2>Map the creative direction across the exact song timing</h2>
      <p>This stage creates timed visual passages for the entire master without deciding individual storyboard shots.</p>
      <button className="primaryButton" disabled={busy} onClick={initialize}>Start Song-to-Picture Plan</button>
    </div>;
  }

  const source=version.sourceContext;

  return <div className="songPictureEditor">
    {props.needsRebase?<div className="warningBanner">One or more locked source versions changed. Start a new Song-to-Picture Plan version before using this one downstream.</div>:null}

    <section className="songPictureSources">
      <div><p className="eyebrow">Pinned sources</p><h2>Plan v{version.versionNumber}</h2>
        <p>Treatment v{version.sourceTreatmentVersionNumber} · Creative Language v{version.sourceCreativeLanguageVersionNumber} · Music Map v{version.sourceMusicMapVersionNumber}</p>
      </div>
      <div className="songPictureFacts">
        <span>{formatTime(source.musicMap.durationMs)} song</span>
        <span>{source.musicMap.tempoBpm?source.musicMap.tempoBpm.toFixed(1)+" BPM":"Tempo not set"}</span>
        <span>{source.musicMap.meterNumerator}/{source.musicMap.meterDenominator}</span>
        <span>{source.musicMap.anchors.length} accepted anchors</span>
      </div>
    </section>

    <section className="songPictureContext">
      <div>
        <p className="eyebrow">Treatment sections</p>
        {source.treatmentSections.map(section=><p key={section.index}><strong>{section.index+1}. {section.title}</strong> · {formatTime(section.startMs)}–{formatTime(section.endMs)}</p>)}
      </div>
      <div>
        <p className="eyebrow">Accepted Music Map anchors</p>
        {source.musicMap.anchors.map(anchor=><p key={anchor.id}><strong>{anchor.label}</strong> · {anchor.kind} · {formatTime(anchor.startMs)}</p>)}
      </div>
    </section>

    <section className="songPictureGenerate">
      <h3>Generate timed visual passages</h3>
      <p className="dashboardNote">Generation uses only the three pinned locked sources above. Storyboard shots remain a later stage.</p>
      <textarea value={direction} disabled={disabled} maxLength={5000} placeholder="Optional additional planning direction..." onChange={e=>setDirection(e.target.value)}/>
      <button className="secondaryButton" disabled={disabled||!props.providerAvailable} onClick={generate}>{active?"Generating…":document.passages.length?"Regenerate plan":"Generate plan"}</button>
      {!props.providerAvailable?<p className="dashboardNote">Configure the text-generation provider to use AI generation. Manual planning remains available.</p>:null}
      {job?<p className="dashboardNote">{job.progressPercent}% · {job.progressMessage??job.status}</p>:null}
    </section>

    <section className="songPictureTopFields">
      {TOP_FIELDS.map(([key,label])=><label key={key}><span>{label}</span><textarea value={String(document[key])} disabled={disabled} onChange={e=>setTop(key,e.target.value)}/></label>)}
    </section>

    <section className="songPicturePassages">
      <div className="songPicturePassageHeader">
        <div><p className="eyebrow">Full-song picture map</p><h3>Visual passages</h3></div>
        <button className="secondaryButton" disabled={disabled||document.passages.length>=64} onClick={()=>{
          setDocument({...document,passages:[...document.passages,emptyPassage(source.musicMap.durationMs)]});setDirty(true);
        }}>Add passage</button>
      </div>

      {document.passages.map((passage,index)=><article className="songPicturePassageCard" key={index}>
        <div className="songPicturePassageTiming">
          <input value={passage.title} disabled={disabled} placeholder="Passage title" onChange={e=>updatePassage(index,{title:e.target.value})}/>
          <label><span>Start ms</span><input type="number" min={0} max={source.musicMap.durationMs} value={passage.startMs} disabled={disabled} onChange={e=>updatePassage(index,{startMs:Number(e.target.value)})}/></label>
          <label><span>End ms</span><input type="number" min={0} max={source.musicMap.durationMs} value={passage.endMs} disabled={disabled} onChange={e=>updatePassage(index,{endMs:Number(e.target.value)})}/></label>
          <label><span>Visual intensity 0–100</span><input type="number" min={0} max={100} value={passage.visualIntensity} disabled={disabled} onChange={e=>updatePassage(index,{visualIntensity:Number(e.target.value)})}/></label>
          <button className="textButton" disabled={disabled||document.passages.length<=2} onClick={()=>{
            setDocument({...document,passages:document.passages.filter((_,i)=>i!==index)});setDirty(true);
          }}>Remove</button>
        </div>

        <div className="songPictureSourceSelectors">
          <fieldset disabled={disabled}>
            <legend>Treatment sections served</legend>
            {source.treatmentSections.map(section=><label key={section.index}>
              <input type="checkbox" checked={passage.treatmentSectionIndexes.includes(section.index)} onChange={e=>{
                const next=e.target.checked?[...passage.treatmentSectionIndexes,section.index]:passage.treatmentSectionIndexes.filter(x=>x!==section.index);
                updatePassage(index,{treatmentSectionIndexes:[...next].sort((a,b)=>a-b)});
              }}/>
              {section.index+1}. {section.title}
            </label>)}
          </fieldset>

          <label><span>Accepted music anchors</span>
            <select multiple disabled={disabled} value={passage.musicAnchorIds} size={Math.min(7,Math.max(3,source.musicMap.anchors.length))} onChange={e=>{
              updatePassage(index,{musicAnchorIds:Array.from(e.currentTarget.selectedOptions).map(option=>option.value)});
            }}>
              {source.musicMap.anchors.map(anchor=><option key={anchor.id} value={anchor.id}>{formatTime(anchor.startMs)} · {anchor.label} · {anchor.kind}</option>)}
            </select>
          </label>
        </div>

        <div className="songPicturePassageGrid">
          {PASSAGE_FIELDS.map(([key,label])=><label key={key}><span>{label}</span><textarea value={passage[key]} disabled={disabled} onChange={e=>updatePassage(index,{[key]:e.target.value})}/></label>)}
        </div>
      </article>)}
    </section>

    {impact.length?<section className="impactWarning"><strong>Downstream work affected</strong>{impact.map(item=><p key={item.stepKey}>{item.title}: {item.locked?"locked content now needs review":"needs review"}</p>)}</section>:null}
    {message?<p className="formMessage">{message}</p>:null}

    <div className="songPictureActions">
      <button className="secondaryButton" disabled={disabled||!dirty} onClick={save}>Save plan</button>
      {status==="COMPLETED"&&!locked?<button className="secondaryButton" disabled={busy} onClick={()=>transition("reopen")}>Reopen</button>:null}
      {status!=="COMPLETED"&&!locked?<button className="primaryButton" disabled={disabled||dirty} onClick={()=>transition("complete")}>Complete plan</button>:null}
      {status==="COMPLETED"&&!locked?<button className="primaryButton" disabled={busy||dirty} onClick={()=>transition("lock")}>Lock plan</button>:null}
    </div>
  </div>;
}
