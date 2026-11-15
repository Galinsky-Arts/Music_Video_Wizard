"use client";

import { useEffect,useMemo,useState } from "react";
import { useLatest } from "./use-latest";
import { useRouter } from "next/navigation";

type JobView={
  id:string;
  status:string;
  progressPercent:number;
  progressMessage:string|null;
  errorMessage:string|null;
}|null;

type ShotSpecification={
  composition:string;
  framing:string;
  cameraAngle:string;
  lens:string;
  lighting:string;
  colorTreatment:string;
  cameraMotion:string;
  subjectMotion:string;
  performanceDirection:string;
  focusAndDepth:string;
  continuityNotes:string;
  wardrobeNotes:string;
  propsNotes:string;
  transitionIn:string;
  transitionOut:string;
  generationHandlesMs:number;
  requiredElements:string[];
  exclusions:string[];
  productionNotes:string;
};

type SpecificationView={
  sequencePosition:number;
  shotPosition:number;
  label:string|null;
  startMs:number|null;
  endMs:number|null;
  sourceStoryboardShotVersionId:string;
  sourceStoryboardShotNodeId:string;
  shotSpecificationVersionId:string;
  shotSpecificationNodeId:string;
  versionNumber:number;
  lifecycle:string;
  lockedAt:string|null;
  specification:ShotSpecification;
};

type StateView={
  sourceReady:boolean;
  providerAvailable:boolean;
  needsRegeneration:boolean;
  recentJob:JobView;
  sourceCreativeLanguageVersionId:string|null;
  specifications:SpecificationView[];
  expectedShotCount:number;
  wizardRevision:number;
  wizardStatus:string;
  wizardLocked:boolean;
};

function timecode(ms:number|null){
  if(ms===null) return "—";
  const total=Math.max(0,ms);
  const minutes=Math.floor(total/60000);
  const seconds=Math.floor((total%60000)/1000);
  const millis=total%1000;
  return String(minutes).padStart(2,"0")+":"+
    String(seconds).padStart(2,"0")+"."+
    String(millis).padStart(3,"0");
}

function list(items:string[]){
  return items.length?items.join(" · "):"None";
}

export function ShotSpecificationsEditor(props:StateView&{projectId:string}){
  const router=useRouter();
  const [state,setState]=useState<StateView>(props);
  const [direction,setDirection]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);

  const active=state.recentJob?.status==="QUEUED"||
    state.recentJob?.status==="RUNNING";
  const complete=state.specifications.length===state.expectedShotCount&&
    state.expectedShotCount>0;

  const sorted=useMemo(
    ()=>[...state.specifications].sort(
      (a,b)=>a.sequencePosition-b.sequencePosition||
        a.shotPosition-b.shotPosition
    ),
    [state.specifications]
  );

  async function refresh(){
    const response=await fetch(
      `/api/projects/${props.projectId}/shot-specifications`,
      {cache:"no-store"}
    );
    if(!response.ok) return;
    const next=await response.json() as StateView;
    setState(next);
  }

  const refreshRef=useLatest(refresh);
  const recentJobId=state.recentJob?.id;
  useEffect(()=>{
    if(!active||!recentJobId) return;
    const jobId=recentJobId;
    const timer=window.setInterval(async()=>{
      const response=await fetch("/api/jobs/"+jobId,{cache:"no-store"});
      if(!response.ok) return;
      const next=await response.json() as NonNullable<JobView>;
      setState(current=>({...current,recentJob:next}));
      if(["SUCCEEDED","FAILED","CANCELLED"].includes(next.status)){
        window.clearInterval(timer);
        await refreshRef.current();
        setMessage(
          next.status==="SUCCEEDED"
            ?"Shot Specifications generated. Review every shot before locking."
            :next.errorMessage??"Shot Specifications generation did not complete."
        );
        router.refresh();
      }
    },2000);
    return ()=>window.clearInterval(timer);
  },[active,recentJobId,router,refreshRef]);

  async function generate(){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch(
        `/api/projects/${props.projectId}/shot-specifications/generate`,
        {
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            expectedWizardRevision:state.wizardRevision,
            direction
          })
        }
      );
      const result=await response.json() as {
        jobId?:string;
        status?:string;
        error?:string;
      };
      if(!response.ok||!result.jobId){
        setMessage(result.error??"Shot Specifications could not be queued.");
        return;
      }
      setState(current=>({
        ...current,
        recentJob:{
          id:result.jobId!,
          status:result.status??"QUEUED",
          progressPercent:0,
          progressMessage:"Queued.",
          errorMessage:null
        }
      }));
      setMessage("Shot Specifications generation queued.");
    }finally{
      setBusy(false);
    }
  }

  async function lock(){
    setBusy(true);
    setMessage(null);
    try{
      const response=await fetch(
        `/api/projects/${props.projectId}/shot-specifications`,
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
        setMessage(result.error??"Shot Specifications could not be locked.");
        return;
      }
      await refresh();
      setMessage("Shot Specifications locked. Initial Frames can now use them.");
      router.refresh();
    }finally{
      setBusy(false);
    }
  }

  if(!state.sourceReady){
    return (
      <div className="creativeLanguageEmpty">
        <p className="eyebrow">Shot Specifications</p>
        <h2>Lock the Storyboard and Creative Language first</h2>
        <p>
          Shot Specifications are generated only from immutable Storyboard shots
          and the locked Creative Language so every downstream image and video
          can be reproduced from exact source versions.
        </p>
      </div>
    );
  }

  return (
    <div className="creativeLanguageEditor">
      {state.needsRegeneration?(
        <div className="warningBanner">
          The current specification set is incomplete or was built from an older
          Creative Language version. Regenerate before locking.
        </div>
      ):null}

      <section className="creativeLanguageSource">
        <div>
          <p className="eyebrow">Generation-ready plan</p>
          <h2>{state.specifications.length} / {state.expectedShotCount} shots specified</h2>
          <p>
            Each card is pinned to one exact locked Storyboard ShotVersion and
            carries the cinematography, performance, continuity, and generation
            constraints needed downstream.
          </p>
        </div>
        <div className="creativeLanguageFacts">
          <span>{state.wizardLocked?"Locked":"Reviewable"}</span>
          <span>{complete?"Complete":"Incomplete"}</span>
          <span>{state.providerAvailable?"AI provider ready":"Provider unavailable"}</span>
        </div>
      </section>

      {!state.wizardLocked?(
        <section className="creativeLanguageGenerate">
          <h3>{complete?"Regenerate Shot Specifications":"Generate Shot Specifications"}</h3>
          <p className="dashboardNote">
            Optional direction applies to the whole specification pass. The
            generator may refine camera, lighting, performance, and continuity,
            but cannot redesign locked Storyboard timing or content.
          </p>
          <textarea
            value={direction}
            disabled={busy||active}
            maxLength={6000}
            placeholder="Optional additional direction for this specification pass..."
            onChange={event=>setDirection(event.target.value)}
          />
          <button
            className="secondaryButton"
            disabled={busy||active||!state.providerAvailable}
            onClick={generate}
          >
            {active?"Generating…":complete?"Regenerate all specifications":"Generate specifications"}
          </button>
          {!state.providerAvailable?(
            <p className="dashboardNote">
              Configure the text-generation provider before generating this stage.
            </p>
          ):null}
          {state.recentJob?(
            <p className="dashboardNote">
              {state.recentJob.progressPercent}% ·{" "}
              {state.recentJob.progressMessage??state.recentJob.status}
            </p>
          ):null}
        </section>
      ):null}

      <section className="creativeLanguageRules">
        {sorted.map(item=>{
          const spec=item.specification;
          return (
            <article className="creativeLanguageCollectionCard" key={item.shotSpecificationVersionId}>
              <div className="creativeLanguageCollectionHeader">
                <div>
                  <p className="eyebrow">
                    Sequence {item.sequencePosition+1} · Shot {item.shotPosition+1}
                  </p>
                  <h3>{item.label??"Storyboard shot"}</h3>
                  <p className="dashboardNote">
                    {timecode(item.startMs)} – {timecode(item.endMs)} ·
                    Specification v{item.versionNumber} · {item.lifecycle}
                  </p>
                </div>
              </div>

              <dl className="specificationGrid">
                <div><dt>Composition</dt><dd>{spec.composition}</dd></div>
                <div><dt>Framing</dt><dd>{spec.framing}</dd></div>
                <div><dt>Camera angle</dt><dd>{spec.cameraAngle}</dd></div>
                <div><dt>Lens</dt><dd>{spec.lens}</dd></div>
                <div><dt>Lighting</dt><dd>{spec.lighting}</dd></div>
                <div><dt>Color</dt><dd>{spec.colorTreatment}</dd></div>
                <div><dt>Camera motion</dt><dd>{spec.cameraMotion}</dd></div>
                <div><dt>Subject motion</dt><dd>{spec.subjectMotion}</dd></div>
                <div><dt>Performance</dt><dd>{spec.performanceDirection}</dd></div>
                <div><dt>Focus / depth</dt><dd>{spec.focusAndDepth}</dd></div>
                <div><dt>Continuity</dt><dd>{spec.continuityNotes}</dd></div>
                <div><dt>Wardrobe</dt><dd>{spec.wardrobeNotes||"—"}</dd></div>
                <div><dt>Props</dt><dd>{spec.propsNotes||"—"}</dd></div>
                <div><dt>Transition in</dt><dd>{spec.transitionIn||"—"}</dd></div>
                <div><dt>Transition out</dt><dd>{spec.transitionOut||"—"}</dd></div>
                <div><dt>Generation handles</dt><dd>{spec.generationHandlesMs} ms each side</dd></div>
                <div><dt>Required</dt><dd>{list(spec.requiredElements)}</dd></div>
                <div><dt>Exclusions</dt><dd>{list(spec.exclusions)}</dd></div>
                <div><dt>Production notes</dt><dd>{spec.productionNotes||"—"}</dd></div>
              </dl>
            </article>
          );
        })}
      </section>

      {message?<p className="formMessage">{message}</p>:null}

      {!state.wizardLocked&&complete&&!state.needsRegeneration?(
        <div className="creativeLanguageActions">
          <button
            className="primaryButton"
            disabled={busy||active}
            onClick={lock}
          >
            Lock Shot Specifications
          </button>
        </div>
      ):null}
    </div>
  );
}
