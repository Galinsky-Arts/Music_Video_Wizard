"use client";

import { useCallback,useEffect,useMemo,useState } from "react";
import { useRouter } from "next/navigation";

type RenderManifest={
  schemaVersion:1;
  projectVersionId:string;
  sourceTimelineVersionId:string;
  sourceTimelineNodeId:string;
  audioMasterAssetVersionId:string;
  audioMasterNodeId:string;
  output:{
    width:number;
    height:number;
    frameRate:number;
    aspectRatio:string;
    container:"mp4";
    videoCodec:"h264";
    audioCodec:"aac";
    pixelFormat:"yuv420p";
  };
  durationMs:number;
  expectedFrameCount:number;
  items:Array<{
    position:number;
    shotVersionId:string;
    clipAssetVersionId:string;
    clipNodeId:string;
    timelineStartMs:number;
    timelineEndMs:number;
    sourceStartMs:number;
    sourceEndMs:number;
  }>;
  transitions:Array<{
    fromPosition:number;
    toPosition:number;
    kind:string;
    durationMs:number;
    parameters:unknown;
  }>;
};

type RenderJob={
  id:string;
  status:string;
  progressPercent:number;
  progressMessage:string|null;
  errorMessage:string|null;
  createdAt:string;
  completedAt:string|null;
}|null;

type MasterView={
  id:string;
  versionNumber:number;
  contentType:string;
  byteSize:string|null;
  checksumSha256:string|null;
  durationMs:number|null;
  frameRate:number|null;
  createdAt:string;
  readyAt:string|null;
  url:string;
  downloadUrl:string;
}|null;

type HistoryView={
  id:string;
  versionNumber:number;
  status:string;
  contentType:string;
  byteSize:string|null;
  checksumSha256:string|null;
  durationMs:number|null;
  frameRate:number|null;
  createdAt:string;
  readyAt:string|null;
  current:boolean;
  downloadUrl:string|null;
};

type FinishExportState={
  sourceReady:boolean;
  sourceError:string|null;
  prepared:boolean;
  needsPrepare:boolean;
  manifest:RenderManifest|null;
  recentJob:RenderJob;
  currentMaster:MasterView;
  renderHistory:HistoryView[];
  wizardRevision:number;
  wizardStatus:string;
  wizardLocked:boolean;
};

function formatTime(ms:number|null){
  if(ms===null) return "—";
  const safe=Math.max(0,ms);
  const minutes=Math.floor(safe/60000);
  const seconds=Math.floor((safe%60000)/1000);
  const millis=safe%1000;
  return String(minutes).padStart(2,"0")+":"+
    String(seconds).padStart(2,"0")+"."+
    String(millis).padStart(3,"0");
}

function formatBytes(value:string|null){
  if(!value) return "—";
  const bytes=Number(value);
  if(!Number.isFinite(bytes)) return value+" bytes";
  const units=["B","KB","MB","GB","TB"];
  let amount=bytes;
  let unit=0;
  while(amount>=1024&&unit<units.length-1){
    amount/=1024;
    unit++;
  }
  return amount.toFixed(unit===0?0:2)+" "+units[unit];
}

function shortHash(value:string|null){
  if(!value) return "—";
  return value.length>20
    ?value.slice(0,12)+"…"+value.slice(-8)
    :value;
}

export function FinishExportEditor(
  props:FinishExportState&{projectId:string}
){
  const router=useRouter();
  const [state,setState]=useState<FinishExportState>(props);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);

  const active=
    state.recentJob?.status==="QUEUED"||
    state.recentJob?.status==="RUNNING";
  const manifest=state.manifest;
  const transitionCount=manifest?.transitions.length??0;
  const explicitTransitions=useMemo(
    ()=>manifest?.transitions.filter(item=>item.durationMs>0).length??0,
    [manifest]
  );

  const refresh=useCallback(async()=>{
    const response=await fetch(
      `/api/projects/${props.projectId}/finish-export`,
      {cache:"no-store"}
    );
    if(!response.ok) throw new Error("Could not refresh export status. Try again.");
    const next=await response.json() as FinishExportState;
    setState(next);
    return next;
  },[props.projectId]);

  useEffect(()=>{
    if(!active) return;
    let cancelled=false;
    let timer:number;
    async function poll(){
      try{
        const next=await refresh();
        if(cancelled) return;
        setMessage(null);
        if(next.recentJob?.status!=="QUEUED"&&next.recentJob?.status!=="RUNNING"){
          router.refresh();
          return;
        }
      }catch{
        if(!cancelled) setMessage("Could not refresh export status. Retrying…");
      }
      if(!cancelled) timer=window.setTimeout(poll,2500);
    }
    timer=window.setTimeout(poll,2500);
    return ()=>{cancelled=true;window.clearTimeout(timer);};
  },[active,refresh,router]);

  async function post(
    path:string,
    success:string
  ){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch(
        `/api/projects/${props.projectId}/finish-export${path}`,
        {
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            expectedWizardRevision:state.wizardRevision
          })
        }
      );
      const result=await response.json() as {
        error?:string;
        jobId?:string;
        versionNumber?:number;
      };
      if(!response.ok){
        setMessage(result.error??"Finish & Export action failed.");
        return;
      }
      await refresh();
      setMessage(
        result.jobId
          ?"Final master render queued."
          :result.versionNumber
            ?success+" Master v"+result.versionNumber+"."
            :success
      );
      router.refresh();
    }catch{
      setMessage("Could not confirm the export action. Refresh status before retrying.");
    }finally{
      setBusy(false);
    }
  }

  async function checkStatus(){
    setBusy(true);
    try{
      await refresh();
      setMessage(null);
      router.refresh();
    }catch{
      setMessage("Could not refresh export status. Try again.");
    }finally{
      setBusy(false);
    }
  }

  if(!state.sourceReady){
    return (
      <div className="creativeLanguageEmpty">
        <p className="eyebrow">Finish & Export</p>
        <h2>Lock Refinement before final delivery</h2>
        <p>
          The final render can only be prepared from a locked working timeline,
          exact source clips, and the immutable audio master.
        </p>
        {state.sourceError?(
          <p className="formMessage">{state.sourceError}</p>
        ):null}
      </div>
    );
  }

  return (
    <div className="finishExportEditor">
      {state.needsPrepare?(
        <div className="warningBanner">
          The locked edit or delivery settings changed. Prepare a new render
          manifest before rendering another master.
        </div>
      ):null}

      <section className="creativeLanguageSource">
        <div>
          <p className="eyebrow">Reproducible final delivery</p>
          <h2>
            {state.currentMaster
              ?"Master v"+state.currentMaster.versionNumber
              :"Final master not rendered"}
          </h2>
          <p>
            The render manifest pins the locked Refinement timeline, immutable
            audio master, exact source clips, trims, transitions, dimensions,
            frame rate, and delivery codecs.
          </p>
        </div>
        <div className="creativeLanguageFacts">
          <span>{state.wizardLocked?"Locked":"Reviewable"}</span>
          <span>{state.prepared?"Manifest prepared":"Prepare required"}</span>
          <span>{state.currentMaster?"Master verified":"No current master"}</span>
          <span>{active?"Rendering":"Renderer idle"}</span>
          <button className="secondaryButton" disabled={busy} onClick={checkStatus}>Refresh status</button>
        </div>
      </section>

      {manifest?(
        <section className="finishManifest">
          <div className="finishManifestHeader">
            <div>
              <p className="eyebrow">Render manifest</p>
              <h3>
                {manifest.output.width} × {manifest.output.height} ·{" "}
                {manifest.output.frameRate} fps
              </h3>
            </div>
            <span>{formatTime(manifest.durationMs)}</span>
          </div>
          <dl className="finishManifestGrid">
            <div><dt>Aspect ratio</dt><dd>{manifest.output.aspectRatio}</dd></div>
            <div><dt>Container</dt><dd>{manifest.output.container.toUpperCase()}</dd></div>
            <div><dt>Video</dt><dd>H.264 · {manifest.output.pixelFormat}</dd></div>
            <div><dt>Audio</dt><dd>AAC · immutable master</dd></div>
            <div><dt>Expected frames</dt><dd>{manifest.expectedFrameCount.toLocaleString()}</dd></div>
            <div><dt>Video items</dt><dd>{manifest.items.length}</dd></div>
            <div><dt>Transitions</dt><dd>{transitionCount}</dd></div>
            <div><dt>Explicit effects</dt><dd>{explicitTransitions}</dd></div>
          </dl>
        </section>
      ):null}

      {!state.wizardLocked?(
        <section className="finishActions">
          <div>
            <p className="eyebrow">1 · Validate source contract</p>
            <h3>Prepare render manifest</h3>
            <p>
              This performs all deterministic media, timing, trim, transition,
              geometry, frame-rate, and audio-duration checks before render work.
            </p>
            <button
              className="secondaryButton"
              disabled={busy||active}
              onClick={()=>post("","Render manifest prepared.")}
            >
              {state.prepared&&!state.needsPrepare
                ?"Revalidate manifest"
                :"Prepare render manifest"}
            </button>
          </div>

          <div>
            <p className="eyebrow">2 · Produce verified master</p>
            <h3>Render final master</h3>
            <p>
              The durable FFmpeg job materializes only the pinned source versions,
              renders and verifies the complete file, hashes it, then stores an
              immutable master AssetVersion.
            </p>
            <button
              className="primaryButton"
              disabled={
                busy||
                active||
                !state.prepared||
                state.needsPrepare
              }
              onClick={()=>post("/render","Final master rendered.")}
            >
              {active
                ?"Rendering…"
                :state.currentMaster
                  ?"Render new master version"
                  :"Render final master"}
            </button>
          </div>
        </section>
      ):null}

      {state.recentJob?(
        <section className="finishRenderJob">
          <div className="finishRenderProgress">
            <strong>{state.recentJob.progressPercent}%</strong>
            <div>
              <span>{state.recentJob.progressMessage??state.recentJob.status}</span>
              <small>{state.recentJob.status}</small>
            </div>
          </div>
          {state.recentJob.errorMessage?(
            <p className="formMessage">{state.recentJob.errorMessage}</p>
          ):null}
        </section>
      ):null}

      {state.currentMaster?(
        <section className="finishMaster">
          <div className="finishMasterHeader">
            <div>
              <p className="eyebrow">Verified current master</p>
              <h3>Master v{state.currentMaster.versionNumber}</h3>
            </div>
            <a
              className="primaryButton"
              href={state.currentMaster.downloadUrl}
              download
            >
              Download MP4
            </a>
          </div>
          <video
            className="finishMasterVideo"
            controls
            preload="metadata"
            playsInline
            src={state.currentMaster.url}
          >
            Your browser does not support video playback.
          </video>
          <dl className="finishMasterFacts">
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(state.currentMaster.byteSize)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatTime(state.currentMaster.durationMs)}</dd>
            </div>
            <div>
              <dt>Frame rate</dt>
              <dd>{state.currentMaster.frameRate??"—"}</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd title={state.currentMaster.checksumSha256??undefined}>
                {shortHash(state.currentMaster.checksumSha256)}
              </dd>
            </div>
          </dl>
        </section>
      ):null}

      {state.renderHistory.length?(
        <section className="finishHistory">
          <div>
            <p className="eyebrow">Master history</p>
            <h3>Immutable render versions</h3>
          </div>
          <div className="finishHistoryList">
            {state.renderHistory.map(item=>(
              <article key={item.id}>
                <strong>v{item.versionNumber}</strong>
                <span>{item.current?"Current":"Historical"}</span>
                <span>{item.status}</span>
                <span>{formatBytes(item.byteSize)}</span>
                <span>{formatTime(item.durationMs)}</span>
                <code title={item.checksumSha256??undefined}>
                  {shortHash(item.checksumSha256)}
                </code>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
                {item.downloadUrl?<a href={item.downloadUrl} download>Download v{item.versionNumber}</a>:null}
              </article>
            ))}
          </div>
        </section>
      ):null}

      {message?<p className="formMessage" role="status">{message}</p>:null}

      {!state.wizardLocked&&
        state.wizardStatus==="COMPLETED"&&
        state.currentMaster&&
        !active&&
        state.prepared&&
        !state.needsPrepare?(
          <div className="creativeLanguageActions">
            <button
              className="primaryButton"
              disabled={busy}
              onClick={()=>post("/lock","Finish & Export locked.")}
            >
              Lock Finish & Export
            </button>
          </div>
        ):null}
    </div>
  );
}
