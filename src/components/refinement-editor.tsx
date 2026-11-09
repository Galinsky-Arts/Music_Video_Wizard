"use client";

import { useEffect,useMemo,useState } from "react";
import { useRouter } from "next/navigation";

type Alternative={
  assetVersionId:string;
  versionNumber:number;
  createdAt:string;
  durationMs:number|null;
  url:string;
};

type RefinementItem={
  id:string;
  position:number;
  shotVersionId:string|null;
  assetVersionId:string|null;
  timelineStartMs:number;
  timelineEndMs:number;
  sourceStartMs:number;
  sourceEndMs:number|null;
  manualOverride:boolean;
  parameters:unknown;
  clipUrl:string|null;
  currentClipVersionNumber:number|null;
  currentGeneratedDurationMs:number|null;
  alternatives:Alternative[];
};

type RefinementTransition={
  id:string;
  fromItemId:string;
  toItemId:string;
  kind:string;
  durationMs:number;
  parameters:unknown;
};

type RefinementVersion={
  id:string;
  versionNumber:number;
  lifecycle:string;
  createdAt:string;
  lockedAt:string|null;
  items:RefinementItem[];
  transitions:RefinementTransition[];
};

type HistoryItem={
  id:string;
  versionNumber:number;
  lifecycle:string;
  notes:string|null;
  createdAt:string;
  lockedAt:string|null;
};

type RefinementState={
  sourceReady:boolean;
  needsInitialize:boolean;
  wizardRevision:number;
  wizardStatus:string;
  wizardLocked:boolean;
  sourceFirstCut:{id:string;versionNumber:number}|null;
  timeline:{id:string;name:string}|null;
  version:RefinementVersion|null;
  history:HistoryItem[];
};

type TransitionDraft={
  kind:string;
  durationMs:string;
  note:string;
};

function asRecord(value:unknown):Record<string,unknown>{
  return value&&typeof value==="object"&&!Array.isArray(value)
    ?value as Record<string,unknown>
    :{};
}

function itemLabel(item:RefinementItem){
  const params=asRecord(item.parameters);
  return typeof params.label==="string"&&params.label.trim()
    ?params.label
    :"Shot "+(item.position+1);
}

function transitionNote(value:unknown){
  const params=asRecord(value);
  return typeof params.note==="string"?params.note:"";
}

function seconds(ms:number){
  return (ms/1000).toFixed(3);
}

function formatTime(ms:number){
  const safe=Math.max(0,ms);
  const minutes=Math.floor(safe/60000);
  const secs=Math.floor((safe%60000)/1000);
  const millis=safe%1000;
  return String(minutes).padStart(2,"0")+":"+
    String(secs).padStart(2,"0")+"."+
    String(millis).padStart(3,"0");
}

export function RefinementEditor(props:RefinementState&{
  projectId:string;
  audioUrl:string|null;
}){
  const router=useRouter();
  const [state,setState]=useState<RefinementState>(props);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const [boundaryDrafts,setBoundaryDrafts]=useState<Record<number,string>>({});
  const [clipDrafts,setClipDrafts]=useState<Record<number,string>>({});
  const [transitionDrafts,setTransitionDrafts]=useState<
    Record<number,TransitionDraft>
  >({});

  const items=useMemo(
    ()=>[...(state.version?.items??[])].sort(
      (a,b)=>a.position-b.position
    ),
    [state.version?.items]
  );

  const itemPositionById=useMemo(
    ()=>new Map(items.map(item=>[item.id,item.position])),
    [items]
  );

  const transitionsByPosition=useMemo(()=>{
    const map=new Map<number,RefinementTransition>();
    for(const transition of state.version?.transitions??[]){
      const position=itemPositionById.get(transition.fromItemId);
      if(position!==undefined) map.set(position,transition);
    }
    return map;
  },[state.version?.transitions,itemPositionById]);

  useEffect(()=>{
    const boundaries:Record<number,string>={};
    const clips:Record<number,string>={};
    const transitionValues:Record<number,TransitionDraft>={};
    for(const item of items){
      clips[item.position]=item.assetVersionId??"";
      if(item.position<items.length-1){
        boundaries[item.position]=seconds(item.timelineEndMs);
        const transition=transitionsByPosition.get(item.position);
        transitionValues[item.position]={
          kind:transition?.kind??"CUT",
          durationMs:String(transition?.durationMs??0),
          note:transitionNote(transition?.parameters)
        };
      }
    }
    setBoundaryDrafts(boundaries);
    setClipDrafts(clips);
    setTransitionDrafts(transitionValues);
  },[state.version?.id,items,transitionsByPosition]);

  async function refresh(){
    const response=await fetch(
      `/api/projects/${props.projectId}/refinement`,
      {cache:"no-store"}
    );
    if(!response.ok) return;
    const next=await response.json() as RefinementState;
    setState(next);
  }

  async function mutate(
    body:Record<string,unknown>,
    success:string
  ){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch(
        `/api/projects/${props.projectId}/refinement`,
        {
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify(body)
        }
      );
      const result=await response.json() as {
        versionNumber?:number;
        changed?:boolean;
        error?:string;
      };
      if(!response.ok){
        setMessage(result.error??"Refinement action failed.");
        return;
      }
      await refresh();
      setMessage(
        result.versionNumber
          ?success+" Working cut v"+result.versionNumber+"."
          :success
      );
      router.refresh();
    }finally{
      setBusy(false);
    }
  }

  async function initialize(){
    await mutate({
      action:"initialize",
      expectedWizardRevision:state.wizardRevision
    },"Refinement initialized.");
  }

  async function retime(position:number){
    if(!state.version) return;
    const raw=Number(boundaryDrafts[position]);
    if(!Number.isFinite(raw)){
      setMessage("Enter a valid cut time in seconds.");
      return;
    }
    await mutate({
      action:"retime",
      expectedWizardRevision:state.wizardRevision,
      expectedTimelineVersionId:state.version.id,
      boundaryPosition:position,
      timelineMs:Math.round(raw*1000)
    },"Cut moved.");
  }

  async function replace(position:number){
    if(!state.version) return;
    const assetVersionId=clipDrafts[position];
    if(!assetVersionId){
      setMessage("Choose a clip version first.");
      return;
    }
    await mutate({
      action:"replace-clip",
      expectedWizardRevision:state.wizardRevision,
      expectedTimelineVersionId:state.version.id,
      position,
      assetVersionId
    },"Clip replaced.");
  }

  async function updateTransitionAt(position:number){
    if(!state.version) return;
    const draft=transitionDrafts[position];
    if(!draft) return;
    const duration=Number(draft.durationMs);
    if(!Number.isFinite(duration)||duration<0){
      setMessage("Transition duration must be a non-negative millisecond value.");
      return;
    }
    await mutate({
      action:"transition",
      expectedWizardRevision:state.wizardRevision,
      expectedTimelineVersionId:state.version.id,
      fromPosition:position,
      kind:draft.kind,
      durationMs:Math.round(duration),
      note:draft.note
    },"Transition updated.");
  }

  async function complete(){
    if(!state.version) return;
    await mutate({
      action:"complete",
      expectedWizardRevision:state.wizardRevision,
      expectedTimelineVersionId:state.version.id
    },"Refinement completed.");
  }

  async function lock(){
    if(!state.version) return;
    await mutate({
      action:"lock",
      expectedWizardRevision:state.wizardRevision,
      expectedTimelineVersionId:state.version.id
    },"Refinement locked.");
  }

  if(!state.sourceReady){
    return (
      <div className="creativeLanguageEmpty">
        <p className="eyebrow">Refinement</p>
        <h2>Lock the Automatic First Cut first</h2>
        <p>
          Refinement starts from a locked First Cut and creates a separate working
          timeline. The locked source edit is never modified.
        </p>
      </div>
    );
  }

  if(state.needsInitialize||!state.version){
    return (
      <div className="creativeLanguageEmpty">
        <p className="eyebrow">Non-destructive working cut</p>
        <h2>Create the Refinement timeline</h2>
        <p>
          Clone locked First Cut v{state.sourceFirstCut?.versionNumber??"?"} into
          a versioned working timeline before making manual editorial changes.
        </p>
        <button
          className="primaryButton"
          disabled={busy}
          onClick={initialize}
        >
          Start Refinement
        </button>
        {message?<p className="formMessage">{message}</p>:null}
      </div>
    );
  }

  return (
    <div className="refinementEditor">
      <section className="creativeLanguageSource">
        <div>
          <p className="eyebrow">Non-destructive working timeline</p>
          <h2>Refinement v{state.version.versionNumber}</h2>
          <p>
            Derived from locked First Cut v
            {state.sourceFirstCut?.versionNumber??"?"}. Every edit creates a new
            working timeline version rather than overwriting history.
          </p>
        </div>
        <div className="creativeLanguageFacts">
          <span>{state.wizardLocked?"Locked":"Editable"}</span>
          <span>{items.length} clips</span>
          <span>{state.version.lifecycle}</span>
          <span>{state.history.length} versions</span>
        </div>
      </section>

      {props.audioUrl?(
        <section className="refinementAudio">
          <p className="eyebrow">Immutable master reference</p>
          <audio
            className="audioPlayer"
            controls
            preload="metadata"
            src={props.audioUrl}
          >
            Your browser does not support audio playback.
          </audio>
        </section>
      ):null}

      <section className="refinementTimeline">
        {items.map((item,index)=>{
          const selectedId=clipDrafts[item.position]??item.assetVersionId??"";
          const selectedAlternative=item.alternatives.find(
            alt=>alt.assetVersionId===selectedId
          );
          const previewUrl=
            selectedAlternative?.url??item.clipUrl;
          const transition=transitionDrafts[item.position];
          return (
            <article className="refinementItem" key={item.id}>
              <div className="refinementClipPreview">
                {previewUrl?(
                  <video
                    controls
                    muted
                    playsInline
                    preload="metadata"
                    src={previewUrl}
                  />
                ):(
                  <div className="initialFramePlaceholder">
                    <span>Clip preview unavailable</span>
                  </div>
                )}
              </div>

              <div className="refinementItemBody">
                <div className="refinementItemHeader">
                  <div>
                    <p className="eyebrow">
                      Shot {item.position+1}
                      {item.manualOverride?" · manually refined":""}
                    </p>
                    <h3>{itemLabel(item)}</h3>
                  </div>
                  <span>
                    {formatTime(item.timelineStartMs)} –{" "}
                    {formatTime(item.timelineEndMs)}
                  </span>
                </div>

                <div className="refinementClipControl">
                  <label>
                    <span>Clip version</span>
                    <select
                      value={selectedId}
                      disabled={busy||state.wizardLocked||item.alternatives.length===0}
                      onChange={event=>setClipDrafts(current=>({
                        ...current,
                        [item.position]:event.target.value
                      }))}
                    >
                      {item.alternatives.length===0?<option value={item.assetVersionId??""}>Imported assembly · current</option>:null}
                      {item.alternatives.map(alt=>(
                        <option
                          key={alt.assetVersionId}
                          value={alt.assetVersionId}
                        >
                          v{alt.versionNumber}
                          {alt.assetVersionId===item.assetVersionId
                            ?" · current":""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="secondaryButton"
                    disabled={
                      busy||
                      state.wizardLocked||
                      !selectedId||
                      selectedId===item.assetVersionId
                    }
                    onClick={()=>replace(item.position)}
                  >
                    Use selected clip
                  </button>
                </div>

                {index<items.length-1?(
                  <div className="refinementBoundary">
                    <div>
                      <strong>Cut after this shot</strong>
                      <span>
                        Current boundary {seconds(item.timelineEndMs)} s
                      </span>
                    </div>
                    <label>
                      <span>Boundary seconds</span>
                      <input
                        type="number"
                        step="0.001"
                        value={boundaryDrafts[item.position]??""}
                        disabled={busy||state.wizardLocked}
                        onChange={event=>setBoundaryDrafts(current=>({
                          ...current,
                          [item.position]:event.target.value
                        }))}
                      />
                    </label>
                    <button
                      className="secondaryButton"
                      disabled={busy||state.wizardLocked}
                      onClick={()=>retime(item.position)}
                    >
                      Move cut
                    </button>
                  </div>
                ):null}

                {index<items.length-1&&transition?(
                  <div className="refinementTransition">
                    <label>
                      <span>Transition kind</span>
                      <input
                        value={transition.kind}
                        disabled={busy||state.wizardLocked}
                        onChange={event=>setTransitionDrafts(current=>({
                          ...current,
                          [item.position]:{
                            ...transition,
                            kind:event.target.value
                          }
                        }))}
                      />
                    </label>
                    <label>
                      <span>Duration ms</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={transition.durationMs}
                        disabled={busy||state.wizardLocked}
                        onChange={event=>setTransitionDrafts(current=>({
                          ...current,
                          [item.position]:{
                            ...transition,
                            durationMs:event.target.value
                          }
                        }))}
                      />
                    </label>
                    <label className="refinementTransitionNote">
                      <span>Editorial note</span>
                      <input
                        value={transition.note}
                        disabled={busy||state.wizardLocked}
                        onChange={event=>setTransitionDrafts(current=>({
                          ...current,
                          [item.position]:{
                            ...transition,
                            note:event.target.value
                          }
                        }))}
                      />
                    </label>
                    <button
                      className="secondaryButton"
                      disabled={busy||state.wizardLocked}
                      onClick={()=>updateTransitionAt(item.position)}
                    >
                      Update transition
                    </button>
                  </div>
                ):null}
              </div>
            </article>
          );
        })}
      </section>

      <section className="refinementHistory">
        <div>
          <p className="eyebrow">Working-version history</p>
          <h3>Every edit remains recoverable</h3>
        </div>
        <div className="refinementHistoryList">
          {state.history.map(entry=>(
            <article key={entry.id}>
              <strong>v{entry.versionNumber}</strong>
              <span>{entry.lifecycle}</span>
              <p>{entry.notes??"Working timeline version."}</p>
              <small>{new Date(entry.createdAt).toLocaleString()}</small>
            </article>
          ))}
        </div>
      </section>

      {message?<p className="formMessage">{message}</p>:null}

      {!state.wizardLocked?(
        <div className="creativeLanguageActions">
          {state.wizardStatus!=="COMPLETED"?(
            <button
              className="primaryButton"
              disabled={busy}
              onClick={complete}
            >
              Complete Refinement
            </button>
          ):(
            <button
              className="primaryButton"
              disabled={busy}
              onClick={lock}
            >
              Lock Refinement
            </button>
          )}
        </div>
      ):null}
    </div>
  );
}
