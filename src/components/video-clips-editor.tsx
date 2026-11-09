"use client";

import { useEffect,useMemo,useState } from "react";
import { useRouter } from "next/navigation";
import { ShotMediaImport } from "./shot-media-import";

type ClipView={
  sequencePosition:number;
  shotPosition:number;
  label:string|null;
  shotSpecificationVersionId:string|null;
  initialFrameAssetVersionId:string|null;
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
  expectedClipCount:number;
  clips:ClipView[];
  recentJobs:JobView[];
  wizardRevision:number;
  wizardStatus:string;
  wizardLocked:boolean;
};

export function VideoClipsEditor(props:StateView&{projectId:string}){
  const router=useRouter();
  const [state,setState]=useState<StateView>(props);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);

  const sorted=useMemo(
    ()=>[...state.clips].sort(
      (a,b)=>a.sequencePosition-b.sequencePosition||
        a.shotPosition-b.shotPosition
    ),
    [state.clips]
  );

  const activeJobs=state.recentJobs.filter(
    job=>job.status==="QUEUED"||job.status==="RUNNING"
  );
  const failedJobs=state.recentJobs.filter(job=>job.status==="FAILED");
  const missing=state.clips.filter(
    clip=>!clip.assetVersionId&&clip.shotSpecificationVersionId
  );
  const currentIds=state.clips
    .map(clip=>clip.shotSpecificationVersionId)
    .filter((value):value is string=>Boolean(value));
  const complete=
    state.expectedClipCount>0&&
    state.clips.filter(clip=>clip.assetVersionId).length===
      state.expectedClipCount;

  async function refresh(){
    const response=await fetch(
      `/api/projects/${props.projectId}/video-clips`,
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
    },3000);
    return ()=>window.clearInterval(timer);
  },[activeJobs.length]);

  async function generate(ids:string[]){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch(
        `/api/projects/${props.projectId}/video-clips/generate`,
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
        setMessage(result.error??"Video Clips could not be queued.");
        return;
      }
      await refresh();
      setMessage(
        result.jobs.length===1
          ?"Video Clip generation queued."
          :result.jobs.length+" Video Clip jobs queued."
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
        `/api/projects/${props.projectId}/video-clips`,
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
        setMessage(result.error??"Video Clips could not be locked.");
        return;
      }
      await refresh();
      setMessage("Video Clips locked. Automatic First Cut can now use them.");
      router.refresh();
    }finally{
      setBusy(false);
    }
  }

  if(!state.sourceReady){
    return (
      <div className="creativeLanguageEmpty">
        <p className="eyebrow">Video Clips</p>
        <h2>Lock Initial Frames first</h2>
        <p>
          Video Clips are generated only from approved Initial Frames and their
          exact locked Shot Specifications so every clip remains reproducible.
        </p>
      </div>
    );
  }

  return (
    <div className="creativeLanguageEditor">
      {state.needsRegeneration?(
        <div className="warningBanner">
          One or more current source pairs do not yet have a current Video Clip.
        </div>
      ):null}

      <section className="creativeLanguageSource">
        <div>
          <p className="eyebrow">Generated moving-image layer</p>
          <h2>
            {state.clips.filter(clip=>clip.assetVersionId).length} /{" "}
            {state.expectedClipCount} clips generated
          </h2>
          <p>
            Each clip is pinned to both its exact locked Shot Specification and
            exact approved Initial Frame AssetVersion.
          </p>
        </div>
        <div className="creativeLanguageFacts">
          <span>{state.wizardLocked?"Locked":"Reviewable"}</span>
          <span>{complete?"Complete":"Incomplete"}</span>
          <span>{activeJobs.length} active jobs</span>
          <span>{state.providerAvailable?"Video provider ready":"Provider unavailable"}</span>
        </div>
      </section>

      {!state.wizardLocked?(
        <section className="creativeLanguageGenerate">
          <h3>Generate Video Clips</h3>
          <p className="dashboardNote">
            Generate only missing clips, regenerate the current set, or replace a
            single shot below. Prior clip versions remain in project history.
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
                  .map(clip=>clip.shotSpecificationVersionId)
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
              Import your own clips, or configure a video-generation provider to generate them.
            </p>
          ):null}

          {activeJobs.length?(
            <div className="videoClipJobList">
              {activeJobs.map(job=>(
                <div key={job.id}>
                  <strong>{job.progressPercent}%</strong>
                  <span>{job.progressMessage??job.status}</span>
                  <small>{job.modelKey??job.providerKey}</small>
                </div>
              ))}
            </div>
          ):null}

          {failedJobs[0]?.errorMessage?(
            <p className="formMessage">{failedJobs[0].errorMessage}</p>
          ):null}
        </section>
      ):null}

      <section className="videoClipGrid">
        {sorted.map(clip=>(
          <article className="videoClipCard" key={clip.sourceStoryboardShotVersionId}>
            <div className="videoClipVisual">
              {clip.url?(
                <video
                  src={clip.url}
                  controls
                  preload="metadata"
                  playsInline
                >
                  Your browser does not support video playback.
                </video>
              ):(
                <div className="initialFramePlaceholder">
                  <span>No clip yet</span>
                </div>
              )}
            </div>
            <div className="videoClipBody">
              <p className="eyebrow">
                Sequence {clip.sequencePosition+1} · Shot {clip.shotPosition+1}
              </p>
              <h3>{clip.label??"Storyboard shot"}</h3>
              <p className="dashboardNote">
                {clip.assetVersionId
                  ?"Asset version "+clip.assetVersionNumber
                  :"Waiting for media"}
              </p>
              {clip.assetVersionId&&clip.createdAt?(
                <p className="dashboardNote">
                  {clip.origin==="import"?"Imported":"Generated"} {new Date(clip.createdAt).toLocaleString()}
                </p>
              ):null}
              {!state.wizardLocked&&clip.shotSpecificationVersionId?(
                <ShotMediaImport projectId={props.projectId} kind="video"
                  shotSpecificationVersionId={clip.shotSpecificationVersionId!}
                  wizardRevision={state.wizardRevision} maxBytes={state.maxMediaUploadBytes} disabled={busy||activeJobs.length>0}
                  onBusyChange={setBusy} onImported={async()=>{await refresh();router.refresh();}} />
              ):null}
              {!state.wizardLocked&&clip.shotSpecificationVersionId?(
                <button
                  className="secondaryButton"
                  disabled={
                    busy||
                    activeJobs.length>0||
                    !state.providerAvailable
                  }
                  onClick={()=>generate([clip.shotSpecificationVersionId!])}
                >
                  {clip.assetVersionId?"Regenerate clip":"Generate clip"}
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
            Lock Video Clips
          </button>
        </div>
      ):null}
    </div>
  );
}
