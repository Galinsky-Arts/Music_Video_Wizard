"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
export function AssemblyImport(props: { projectId: string; revision: number; maxBytes: number }) {
  const router = useRouter();
  const [busy,setBusy] = useState(false), [message,setMessage] = useState<string|null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const body = new FormData(event.currentTarget);
    body.set("expectedWizardRevision", String(props.revision)); setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${props.projectId}/assembly`, { method: "POST", body });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setMessage(result.error ?? "Import failed."); return; }
      router.push(`/app/projects/${props.projectId}/wizard?step=refinement`); router.refresh();
    } catch { setMessage("Could not confirm the import. Refresh before trying again."); }
    finally { setBusy(false); }
  }
  return <form className="projectForm" onSubmit={submit}>
    <label><span>Complete visual edit</span><input name="media" type="file" accept="video/mp4,video/webm" required disabled={busy}/></label>
    <p className="dashboardNote">H.264 MP4 or VP8/VP9 WebM, up to {Math.floor(props.maxBytes/1048576)} MB. The video must cover the complete song. Its audio is replaced by the original project master.</p>
    <label><span>Delivery resolution</span><select name="height" defaultValue="720" disabled={busy}><option value="720">720p</option><option value="1080">1080p</option></select></label>
    <button className="primaryButton" type="submit" disabled={busy}>{busy?"Inspecting and importing…":"Import visual edit"}</button>
    {message?<p className="formMessage" role="status">{message}</p>:null}
  </form>;
}
