"use client";
import { useEffect, useRef, useState } from "react";
import type { NarrativePlan } from "@/lib/narrative/plan";
import { assembleMovie, capability, clearClips, clearModel, exclusively, fingerprint, generate, keepClip, MODEL_BYTES, prepare, readClip, type Progress } from "@/browser-gpu/client";

const size = (MODEL_BYTES / 1e9).toFixed(1);
export function LocalVideoStudio({ projectId, audioId, plan, disabled, onBusyChange }: { projectId: string; audioId: string; plan: NarrativePlan; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [support, setSupport] = useState<string | null | undefined>(undefined), [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null), [message, setMessage] = useState("");
  const [completed, setCompleted] = useState(0), [preview, setPreview] = useState<{ url: string; movie: boolean } | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { let active = true; void capability().then(value => { if (active) setSupport(value); }).catch(() => { if (active) setSupport("The browser could not access the GPU. Check that hardware acceleration is enabled, then reload."); }); return () => { active = false; }; }, []);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { void (async () => {
      const id = await fingerprint(projectId, audioId, plan);
      const clips = await Promise.all(plan.shots.map(shot => readClip(`${projectId}:${id}:${shot.id}`)));
      if (active) setCompleted(clips.filter(Boolean).length);
    })().catch(() => { if (active) setMessage("Browser storage is unavailable. Allow site storage to keep generated shots."); }); }, 300);
    setPreview(null); setCompleted(0);
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, audioId, plan]);

  async function run(movie: boolean) {
    const abort = new AbortController(); controller.current = abort;
    const snapshot = structuredClone(plan);
    setRunning(true); onBusyChange(true); setMessage(""); setPreview(null);
    try {
      await exclusively(async () => {
        const id = await fingerprint(projectId, audioId, snapshot), clips: Blob[] = [];
        const shots = movie ? snapshot.shots : snapshot.shots.slice(0, 1);
        let prepared = false;
        for (const [index, shot] of shots.entries()) {
          abort.signal.throwIfAborted();
          const key = `${projectId}:${id}:${shot.id}`;
          let clip = await readClip(key);
          if (!clip) {
            if (!prepared) { await prepare(abort.signal, setProgress); prepared = true; }
            clip = await generate(shot.prompt, abort.signal, p => setProgress({ ...p, phase: `Shot ${index + 1}/${shots.length} · ${p.phase}` }));
            abort.signal.throwIfAborted(); await keepClip(key, clip);
          }
          clips.push(clip); setCompleted(index + 1);
        }
        const blob = movie ? await assembleMovie(projectId, audioId, snapshot, clips, abort.signal, setProgress) : clips[0]!;
        abort.signal.throwIfAborted(); setPreview({ url: URL.createObjectURL(blob), movie });
        setMessage(movie ? "Your music video is ready to preview and download. It was generated on this device." : "First shot generated on this device. Preview it before making the full movie.");
      });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Local generation failed. Completed shots are kept for retry."); }
    finally { setProgress(null); setRunning(false); onBusyChange(false); controller.current = null; }
  }
  async function clear(kind: "model" | "shots") {
    setMessage(""); setRunning(true); onBusyChange(true);
    try {
      await exclusively(async () => {
        if (kind === "model") { await clearModel(); setMessage("AI model cache removed from this browser."); }
        else { await clearClips(projectId); setPreview(null); setCompleted(0); setMessage("Generated shots for this project removed from this browser."); }
      });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not clear browser storage."); }
    finally { setRunning(false); onBusyChange(false); }
  }
  const fraction = progress?.total ? (progress.loaded ?? progress.done ?? 0) / progress.total : null;
  return <section className="dashboardCard" aria-labelledby="local-video-heading">
    <h2 id="local-video-heading">Create video on this device</h2>
    <p>Use your computer’s GPU right here in the wizard. No installation, cloud generation credits, or API key.</p>
    <p className="dashboardNote">FastWan AI model: {size} GB download on first use, cached in this browser. Generates 832 × 480 video. Keep this tab open while it works; completed shots resume on this device. Character descriptions guide continuity, but identical faces across shots are not guaranteed.</p>
    <p className="dashboardNote">Each generated take is about five seconds. The full movie retimes those takes to your planned shot lengths and keeps the original song at its original speed. Your existing project edit stays intact; download the new movie here.</p>
    {support === undefined ? <p>Checking browser GPU support…</p> : support ? <p className="formMessage">{support}</p> : <p>Browser GPU available. {completed}/{plan.shots.length} shots kept on this device.</p>}
    <div className="projectActions">
      <button type="button" className="secondaryButton" disabled={disabled || running || (support !== null && completed === 0)} onClick={() => void run(false)}>Generate first shot on this device</button>
      <button type="button" className="primaryButton" disabled={disabled || running || (support !== null && completed !== plan.shots.length)} onClick={() => void run(true)}>Generate full music video</button>
      {running && controller.current ? <button type="button" className="secondaryButton" onClick={() => controller.current?.abort()}>Stop generation</button> : null}
    </div>
    {progress ? <div role="status"><p>{progress.phase}</p>{fraction !== null ? <><progress max={1} value={fraction} aria-label="Local generation progress"/><p>{Math.round(fraction * 100)}%</p></> : null}</div> : null}
    {message ? <p className="formMessage" role="status">{message}</p> : null}
    {preview ? <div><video controls preload="metadata" src={preview.url} style={{ width: "100%", maxHeight: 480 }} aria-label={preview.movie ? "Generated music video" : "Generated first shot"}/><a className="primaryButton" href={preview.url} download={preview.movie ? "Music_Video.mp4" : "First_Shot.mp4"}>{preview.movie ? "Download music video" : "Download first shot"}</a></div> : null}
    <details><summary>Storage on this device</summary><p>Model files and generated shots stay in this browser’s storage until you remove them or the browser clears site data. Download your finished video to keep it.</p>
      <button type="button" className="secondaryButton" disabled={disabled || running} onClick={() => void clear("model")}>Clear AI model cache ({size} GB)</button>
      <button type="button" className="secondaryButton" disabled={disabled || running} onClick={() => void clear("shots")}>Clear this project’s local shots</button>
      <p><a href="https://huggingface.co/jean-is/FastWan2.2-TI2V-5B-ONNX">AI model details</a> · <a href="/browser-gpu/LICENSES.txt">Open-source licenses</a></p>
    </details>
  </section>;
}
