"use client";

import { useId, useState, type FormEvent } from "react";

export function ShotMediaImport(props: {
  projectId: string; kind: "image" | "video"; shotSpecificationVersionId: string;
  wizardRevision: number; maxBytes?: number; disabled: boolean; onBusyChange: (busy: boolean) => void; onImported: () => Promise<void>;
}) {
  const id = useId();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const body = new FormData(formElement);
    body.set("kind", props.kind);
    body.set("shotSpecificationVersionId", props.shotSpecificationVersionId);
    body.set("expectedWizardRevision", String(props.wizardRevision));
    setPending(true);
    props.onBusyChange(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${props.projectId}/media-import`, { method: "POST", body });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setMessage(result.error ?? "Import failed. Refresh and try again."); return; }
      await props.onImported();
      formElement.reset();
      setMessage("Imported as a new version. Previous media is preserved.");
    } catch { setMessage("Could not confirm the import. Refresh the project before trying again."); }
    finally { setPending(false); props.onBusyChange(false); }
  }
  return (
    <form onSubmit={submit} className="mediaImportForm">
      <label htmlFor={id}>{props.kind === "image" ? "Import your own frame" : "Import your own clip"}</label>
      <input id={id} name="media" type="file" required disabled={props.disabled || pending}
        accept={props.kind === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm"} />
      <button type="submit" className="secondaryButton" disabled={props.disabled || pending}>
        {pending ? "Importing…" : props.kind === "image" ? "Import frame" : "Import clip"}
      </button>
      <small>{props.kind === "image" ? "PNG, JPEG or WebP" : "H.264 MP4 or VP8/VP9 WebM"} · up to {Math.floor((props.maxBytes??52428800)/1048576)} MB</small>
      {message ? <p className="formMessage" role="status">{message}</p> : null}
    </form>
  );
}
