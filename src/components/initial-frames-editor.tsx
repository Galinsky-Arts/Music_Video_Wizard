"use client";

import { useEffect,useMemo,useState } from "react";
import { useRouter } from "next/navigation";
import { ShotMediaImport } from "./shot-media-import";

type FrameView={
  sequencePosition:number;
  shotPosition:number;
  label:string|null;
  shotSpecificationVersionId:string|null;
  sourceStoryboardShotVersionId:string;
  assetId:string|null;
  assetVersionId:string|null;
  assetVersionNumber:number|null;
  url:string|null;
  contentType:string|null;
  origin?:string;
  createdAt:string|null;
};

type JobView={
  id:string;
  status:string;
  progressPercent:number;
  progressMessage:string|null;
  errorMessage:string|null;
  modelKey:string|null;
  providerKey:string;
};

type StateView={
  maxMediaUploadBytes?:number;
  sourceReady:boolean;
  providerAvailable:boolean;
  needsRegeneration:boolean;
  expectedFrameCount:number;
  frames:FrameView[];
  recentJobs:JobView[];
  wizardRevision:number;
  wizardStatus:string;
  wizardLocked:boolean;
};

export function InitialFramesEditor(props:StateView&{projectId:string}){
  const router=useRouter();
  const [state,setState]=useState<StateView>(props);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);

  const sorted=useMemo(
    ()=>[...state.frames].sort(
      (a,b)=>a.sequencePosition-b.sequencePosition||
        a.shotPosition-b.shotPosition
    ),
    [state.frames]
  );

  const activeJobs=state.recentJobs.filter(
    job=>job.status==="QUEUED"||job.status==="RUNNING"
  );
  const failedJobs=state.recentJobs.filter(job=>job.status==="FAILED");
  const missing=state.frames.filter(
    frame=>!frame.assetVersionId&&frame.shotSpecificationVersionId
  );
  const currentIds=state.frames
    .map(frame=>frame.shotSpecificationVersionId)
    .filter((value):value is string=>Boolean(value));
  const complete=
    state.expectedFrameCount>0&&
    state.frames.filter(frame=>frame.assetVersionId).length===
      state.expectedFrameCount;

  async function refresh(){
    const response=await fetch(
      `/api/projects/${props.projectId}/initial-frames`,
      {cache:"no-store"}
    );
    if(!response.ok) return;
    const next=await response.json() as StateView;
    setState(next);
  }

  useEffect(()=>{
    if(!activeJobs.length) return;
    const timer=window.setInterval(async()=>{
      await refresh();
    },2000);
    return ()=>window.clearInterval(timer);
  },[activeJobs.length]);

  async function generate(ids:string[]){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch(
        `/api/projects/${props.projectId}/initial-frames/generate`,
        {
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            expectedWizardRevision:state.wizardRevision,
            shotSpecificationVersionIds:ids
          })
        }
      );
      const result=await response.json() as {
        jobs?:Array<{jobId:string;status:string}>;
        error?:string;
      };
      if(!response.ok||!result.jobs){
        setMessage(result.error??"Initial Frames could not be queued.");
        return;
      }
      await refresh();
      setMessage(
        result.jobs.length===1
          ?"Initial Frame generation queued."
          :result.jobs.length+" Initial Frame jobs queued."
      );
      router.refresh();
    }finally{
      setBusy(false);
    }
  }

  async function lock(){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch(
        `/api/projects/${props.projectId}/initial-frames`,
        {
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            action:"lock",
            expectedWizardRevision:state.wizardRevision
          })
        }
      );
      const result=await response.json() as {error?:string};
      if(!response.ok){
        setMessage(result.error??"Initial Frames could not be locked.");
        return;
      }
      await refresh();
      setMessage("Initial Frames locked. Video Clips can now use them.");
      router.refresh();
    }finally{
      setBusy(false);
    }
  }

  if(!state.sourceReady){
    return (
      <div className="creativeLanguageEmpty">
        <p className="eyebrow">Initial Frames</p>
        <h2>Lock Shot Specifications first</h2>
        <p>
          Initial Frames are generated only from locked specifications so every
          approved starting image has exact, reproducible creative provenance.
        </p>
      </div>
    );
  }

  return (
    <div className="creativeLanguageEditor">
      {state.needsRegeneration?(
        <div className="warningBanner">
          One or more current locked Shot Specifications do not yet have a
          current Initial Frame.
        </div>
      ):null}

      <section className="creativeLanguageSource">
        <div>
          <p className="eyebrow">Approved starting-image layer</p>
          <h2>
            {state.frames.filter(frame=>frame.assetVersionId).length} /{" "}
            {state.expectedFrameCount} frames generated
          </h2>
          <p>
            Each frame is a versioned generated-image asset pinned to one exact
            locked Shot Specification.
          </p>
        </div>
        <div className="creativeLanguageFacts">
          <span>{state.wizardLocked?"Locked":"Reviewable"}</span>
          <span>{complete?"Complete":"Incomplete"}</span>
          <span>{activeJobs.length} active jobs</span>
          <span>{state.providerAvailable?"Image provider ready":"Provider unavailable"}</span>
        </div>
      </section>

      {!state.wizardLocked?(
        <section className="creativeLanguageGenerate">
          <h3>Generate Initial Frames</h3>
          <p className="dashboardNote">
            Generate only missing frames, regenerate every current frame, or
            regenerate a single shot below. Existing versions are preserved.
          </p>
          <div className="creativeLanguageActions">
            <button
              className="secondaryButton"
              disabled={
                busy||
                activeJobs.length>0||
                !state.providerAvailable||
                missing.length===0
              }
              onClick={()=>generate(
                missing
                  .map(frame=>frame.shotSpecificationVersionId)
                  .filter((value):value is string=>Boolean(value))
              )}
            >
              Generate missing ({missing.length})
            </button>
            <button
              className="secondaryButton"
              disabled={
                busy||
                activeJobs.length>0||
                !state.providerAvailable||
                currentIds.length===0
              }
              onClick={()=>generate(currentIds)}
            >
              Regenerate all
            </button>
          </div>
          {!state.providerAvailable?(
            <p className="dashboardNote">
              Import your own frames, or configure an image-generation provider to generate them.
            </p>
          ):null}
          {activeJobs.length?(
            <p className="dashboardNote">
              {activeJobs.length} frame job{activeJobs.length===1?"":"s"} running.
            </p>
          ):null}
          {failedJobs[0]?.errorMessage?(
            <p className="formMessage">{failedJobs[0].errorMessage}</p>
          ):null}
        </section>
      ):null}

      <section className="initialFrameGrid">
        {sorted.map(frame=>(
          <article className="initialFrameCard" key={frame.sourceStoryboardShotVersionId}>
            <div className="initialFrameVisual">
              {frame.url?(
                <img
                  src={frame.url}
                  alt={frame.label??"Generated Initial Frame"}
                />
              ):(
                <div className="initialFramePlaceholder">
                  <span>No frame yet</span>
                </div>
              )}
            </div>
            <div className="initialFrameBody">
              <p className="eyebrow">
                Sequence {frame.sequencePosition+1} · Shot {frame.shotPosition+1}
              </p>
              <h3>{frame.label??"Storyboard shot"}</h3>
              <p className="dashboardNote">
                {frame.assetVersionId
                  ?"Asset version "+frame.assetVersionNumber
                  :"Waiting for media"}
              </p>
              {frame.assetVersionId&&frame.createdAt?(
                <p className="dashboardNote">
                  {frame.origin==="import"?"Imported":"Generated"} {new Date(frame.createdAt).toLocaleString()}
                </p>
              ):null}
              {!state.wizardLocked&&frame.shotSpecificationVersionId?(
                <ShotMediaImport projectId={props.projectId} kind="image"
                  shotSpecificationVersionId={frame.shotSpecificationVersionId!}
                  wizardRevision={state.wizardRevision} maxBytes={state.maxMediaUploadBytes} disabled={busy||activeJobs.length>0}
                  onBusyChange={setBusy} onImported={async()=>{await refresh();router.refresh();}} />
              ):null}
              {!state.wizardLocked&&frame.shotSpecificationVersionId?(
                <button
                  className="secondaryButton"
                  disabled={
                    busy||
                    activeJobs.length>0||
                    !state.providerAvailable
                  }
                  onClick={()=>generate([frame.shotSpecificationVersionId!])}
                >
                  {frame.assetVersionId?"Regenerate frame":"Generate frame"}
                </button>
              ):null}
            </div>
          </article>
        ))}
      </section>

      {message?<p className="formMessage">{message}</p>:null}

      {!state.wizardLocked&&complete&&!state.needsRegeneration?(
        <div className="creativeLanguageActions">
          <button
            className="primaryButton"
            disabled={busy||activeJobs.length>0}
            onClick={lock}
          >
            Lock Initial Frames
          </button>
        </div>
      ):null}
    </div>
  );
}
