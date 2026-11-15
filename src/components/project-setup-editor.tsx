"use client";

import { useEffect, useRef, useState } from "react";
import { useLatest } from "./use-latest";

interface ProjectSetupDraft {
  title: string;
  description: string;
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "2.39:1";
  frameRate: number;
}

interface ImpactWarning {
  stepKey: string;
  title: string;
  locked: boolean;
}

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

export function ProjectSetupEditor(props: {
  projectId: string;
  initialPayload: ProjectSetupDraft;
  initialRevision: number;
  initialStatus: string;
  locked: boolean;
  downstreamImpact: ImpactWarning[];
}) {
  const [payload, setPayload] = useState(props.initialPayload);
  const [status, setStatus] = useState(props.initialStatus);
  const [locked, setLocked] = useState(props.locked);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [impactWarnings, setImpactWarnings] = useState(
    props.downstreamImpact
  );

  const revisionRef = useRef(props.initialRevision);
  const lastSavedJsonRef = useRef(JSON.stringify(props.initialPayload));
  const latestJsonRef = useRef(lastSavedJsonRef.current);
  const savingRef = useRef(false);
  const queuedRef = useRef<{
    draft: ProjectSetupDraft;
    json: string;
  } | null>(null);

  const editable =
    !locked &&
    status !== "COMPLETED";

  async function saveDraft(
    draft: ProjectSetupDraft,
    json: string
  ): Promise<void> {
    if (savingRef.current) {
      queuedRef.current = { draft, json };
      return;
    }
    if (json === lastSavedJsonRef.current) return;

    savingRef.current = true;
    setSaveState("saving");
    setMessage(null);

    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/wizard/steps/project-setup`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: revisionRef.current,
            payload: draft
          })
        }
      );
      const result = (await response.json()) as {
        progressRevision?: number;
        impactWarnings?: ImpactWarning[];
        error?: string;
      };

      if (!response.ok || result.progressRevision === undefined) {
        if (response.status === 409) {
          setSaveState("conflict");
        } else {
          setSaveState("error");
        }
        setMessage(result.error ?? "Autosave failed.");
        return;
      }

      revisionRef.current = result.progressRevision;
      lastSavedJsonRef.current = json;
      if (result.impactWarnings?.length) {
        setImpactWarnings(result.impactWarnings);
      }
      setStatus("IN_PROGRESS");
      setSaveState(
        latestJsonRef.current === json ? "saved" : "unsaved"
      );
    } catch {
      setSaveState("error");
      setMessage("Autosave failed.");
    } finally {
      savingRef.current = false;
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued && queued.json !== lastSavedJsonRef.current) {
        void saveDraft(queued.draft, queued.json);
      }
    }
  }

  const saveDraftRef = useLatest(saveDraft);
  useEffect(() => {
    const json = JSON.stringify(payload);
    latestJsonRef.current = json;
    if (!editable || json === lastSavedJsonRef.current) return;

    setSaveState((current) =>
      current === "saving" ? current : "unsaved"
    );
    const timer = window.setTimeout(() => {
      void saveDraftRef.current(payload, json);
    }, 700);

    return () => window.clearTimeout(timer);
  }, [payload, editable, saveDraftRef]);

  async function transition(action: "complete" | "lock" | "reopen") {
    setMessage(null);
    const response = await fetch(
      `/api/projects/${props.projectId}/wizard/steps/project-setup/transition`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: revisionRef.current,
          action
        })
      }
    );
    const result = (await response.json()) as {
      progressRevision?: number;
      status?: string;
      locked?: boolean;
      impactWarnings?: ImpactWarning[];
      error?: string;
    };

    if (!response.ok || result.progressRevision === undefined) {
      setMessage(result.error ?? "Step transition failed.");
      if (response.status === 409) setSaveState("conflict");
      return;
    }

    revisionRef.current = result.progressRevision;
    if (result.status) setStatus(result.status);
    if (typeof result.locked === "boolean") {
      setLocked(result.locked);
    }
    if (result.impactWarnings?.length) {
      setImpactWarnings(result.impactWarnings);
    }

    if (action === "complete") {
      setStatus("COMPLETED");
      setMessage("Project setup marked complete.");
    } else if (action === "lock") {
      setLocked(true);
      setMessage("Project setup locked for this project version.");
    } else {
      setStatus("IN_PROGRESS");
      setMessage("Project setup reopened.");
    }
  }

  const dirty = latestJsonRef.current !== lastSavedJsonRef.current;

  return (
    <div className="wizardEditor">
      {impactWarnings.length ? (
        <div className="impactWarning" role="note">
          <strong>Backtracking impact</strong>
          <p>
            Saving changes here will mark the following downstream work for
            review:
          </p>
          <ul>
            {impactWarnings.map((warning) => (
              <li key={warning.stepKey}>
                {warning.title}
                {warning.locked ? " (locked content preserved)" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="autosaveStatus" aria-live="polite">
        <span className={"autosaveDot autosaveDot-" + saveState} />
        {saveState === "saved"
          ? "All changes saved"
          : saveState === "saving"
            ? "Saving…"
            : saveState === "unsaved"
              ? "Unsaved changes"
              : saveState === "conflict"
                ? "Another tab changed this project — reload required"
                : "Autosave error"}
      </div>

      <div className="projectForm">
        <label>
          <span>Project title</span>
          <input
            value={payload.title}
            maxLength={160}
            disabled={!editable}
            onChange={(event) =>
              setPayload((current) => ({
                ...current,
                title: event.target.value
              }))
            }
          />
        </label>

        <label>
          <span>Description</span>
          <textarea
            value={payload.description}
            maxLength={5000}
            rows={4}
            disabled={!editable}
            onChange={(event) =>
              setPayload((current) => ({
                ...current,
                description: event.target.value
              }))
            }
          />
        </label>

        <div className="projectFormGrid">
          <label>
            <span>Aspect ratio</span>
            <select
              value={payload.aspectRatio}
              disabled={!editable}
              onChange={(event) =>
                setPayload((current) => ({
                  ...current,
                  aspectRatio: event.target
                    .value as ProjectSetupDraft["aspectRatio"]
                }))
              }
            >
              <option value="16:9">16:9 — landscape</option>
              <option value="9:16">9:16 — vertical</option>
              <option value="1:1">1:1 — square</option>
              <option value="4:3">4:3</option>
              <option value="2.39:1">2.39:1 — cinematic</option>
            </select>
          </label>

          <label>
            <span>Frame rate</span>
            <select
              value={String(payload.frameRate)}
              disabled={!editable}
              onChange={(event) =>
                setPayload((current) => ({
                  ...current,
                  frameRate: Number(event.target.value)
                }))
              }
            >
              <option value="23.976">23.976 fps</option>
              <option value="24">24 fps</option>
              <option value="25">25 fps</option>
              <option value="29.97">29.97 fps</option>
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
            </select>
          </label>
        </div>
      </div>

      {message ? <p className="wizardMessage">{message}</p> : null}

      <div className="wizardStepActions">
        {status === "COMPLETED" && !locked ? (
          <>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => void transition("reopen")}
            >
              Reopen for changes
            </button>
            <button
              className="primaryButton"
              type="button"
              onClick={() => void transition("lock")}
            >
              Lock step
            </button>
          </>
        ) : null}

        {status !== "COMPLETED" && !locked ? (
          <button
            className="primaryButton"
            type="button"
            disabled={
              dirty ||
              saveState === "saving" ||
              saveState === "error" ||
              saveState === "conflict" ||
              !payload.title.trim()
            }
            onClick={() => void transition("complete")}
          >
            Mark step complete
          </button>
        ) : null}

        {locked ? (
          <span className="wizardLockedLabel">
            Locked in this project version
          </span>
        ) : null}
      </div>
    </div>
  );
}
