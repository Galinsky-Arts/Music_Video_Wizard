"use client";
import { useState } from "react";
import { createResonancePlan, narrativePlanSchema, type NarrativePlan } from "@/lib/narrative/plan";
function clock(ms: number) { return `${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,"0")}`; }
export function NarrativeEditor(props: { projectId: string; durationMs: number | null; versionId: string | null; savedPlan: NarrativePlan | null; provider: string }) {
  const [plan, setPlan] = useState(props.savedPlan ?? (props.durationMs && props.durationMs >= 30000 && props.durationMs <= 600000 ? createResonancePlan(props.durationMs) : null));
  const [versionId, setVersionId] = useState(props.versionId), [busy,setBusy] = useState(false), [message,setMessage] = useState("");
  if (!plan) return <p className="dashboardNote">Measure the original soundtrack in the music analysis stage first. This narrative template supports songs from 30 seconds to ten minutes.</p>;
  const currentPlan = plan;
  async function save() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/projects/${props.projectId}/narrative`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersionId: versionId, plan: currentPlan }) });
      const result = await response.json(); if (!response.ok) { setMessage(result.error ?? "Could not save story."); return; }
      setVersionId(result.versionId); setMessage(`Story version ${result.versionNumber} saved. No generation jobs were started.`);
    } catch { setMessage("Could not confirm the save. Reload before trying again."); } finally { setBusy(false); }
  }
  function updateCharacter(index: number, description: string) {
    const nextCast = currentPlan.cast.map((c,i)=>i===index?{...c,description}:c);
    const describe = (items: NarrativePlan["cast"]) => "Character continuity: " + items.map(c=>c.name+": "+c.description).join("\n");
    setPlan({...currentPlan,cast:nextCast,shots:currentPlan.shots.map(shot=>({...shot,prompt:shot.prompt.replace(describe(currentPlan.cast),describe(nextCast))}))});
  }
  function exportPlan() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(currentPlan,null,2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "narrative-production-plan.json"; a.click(); URL.revokeObjectURL(url);
  }
  async function importPlan(file: File | undefined) {
    if (!file) return;
    if (file.size > 256*1024) { setMessage("Story files must be under 256 KB."); return; }
    try { const next = narrativePlanSchema.parse(JSON.parse(await file.text())); if (next.durationMs !== props.durationMs) throw new Error(); setPlan(next); setMessage("Story imported. Save to keep a project version."); }
    catch { setMessage("The story file is invalid or its timing does not match the original song."); }
  }
  return <div className="projectForm">
    <label><span>Story title</span><input value={plan.title} maxLength={160} onChange={e=>setPlan({...plan,title:e.target.value})}/></label>
    <label><span>Logline</span><textarea value={plan.logline} maxLength={2000} onChange={e=>setPlan({...plan,logline:e.target.value})}/></label>
    <p className="dashboardNote">{clock(plan.durationMs)} · {plan.shots.length} planned shots · Video provider: {props.provider}. This is a director-authored planning document. Saving it does not complete wizard stages or generate video.</p>
    <h2>Character continuity</h2>
    {plan.cast.map((character,i)=><label key={i}><span>{character.name}</span><textarea aria-label={character.name} value={character.description} maxLength={2000} onChange={e=>updateCharacter(i,e.target.value)}/></label>)}
    <h2>Story beats</h2>
    {plan.beats.map(beat=><section className="dashboardCard" key={beat.title}><p className="eyebrow">{clock(beat.startMs)}–{clock(beat.endMs)}</p><h3>{beat.title}</h3><p>{beat.goal}</p>
      {plan.shots.filter(shot=>shot.beat===beat.title).map(shot=><details key={shot.id}><summary>{shot.id} · {clock(shot.startMs)} · {shot.action}</summary><p>{shot.consequence}</p><label><span>AI video prompt for {shot.id}</span><textarea rows={8} value={shot.prompt} maxLength={12000} onChange={e=>setPlan({...plan,shots:plan.shots.map(s=>s.id===shot.id?{...s,prompt:e.target.value}:s)})}/></label></details>)}
    </section>)}
    <p className="dashboardNote">Review these beats in the treatment and storyboard, then approve consistent first frames before generating clips. ComfyUI uses your own GPU; Runway uses paid credits when configured. This screen starts no provider calls.</p>
    <button className="primaryButton" disabled={busy || !plan.title.trim() || !plan.logline.trim()} onClick={save}>{busy?"Saving…":"Save narrative plan"}</button>
    <button className="secondaryButton" disabled={busy} onClick={exportPlan}>Download story and shot prompts</button>
    <label><span>Import edited story JSON</span><input type="file" accept="application/json,.json" disabled={busy} onChange={e=>void importPlan(e.target.files?.[0])}/></label>
    {message?<p className="formMessage" role="status">{message}</p>:null}
  </div>;
}
