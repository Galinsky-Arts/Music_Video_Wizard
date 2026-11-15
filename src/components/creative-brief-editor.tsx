"use client";

import type { Route } from "next";
import { useEffect, useRef, useState } from "react";
import { useLatest } from "./use-latest";
import { useRouter } from "next/navigation";
import type { CreativeBriefDraft } from "@/lib/creative-brief/input";

interface ImpactWarning {
  stepKey: string;
  title: string;
  locked: boolean;
}

interface SourceAnchor {
  id: string;
  kind: string;
  label: string;
  startMs: number;
  endMs: number | null;
  source: string;
}

interface SourceMap {
  id: string;
  versionNumber: number;
  lifecycle: string;
  tempoBpm: number | null;
  meterNumerator: number;
  meterDenominator: number;
  durationMs: number;
  acceptedAnchors: SourceAnchor[];
}

interface BriefVersion {
  id: string;
  nodeId: string;
  versionNumber: number;
  lifecycle: "DRAFT" | "LOCKED" | "SUPERSEDED";
  sourceMusicMapVersionId: string;
  sourceMusicMapVersionNumber: number;
  revision: number;
  brief: CreativeBriefDraft;
  sourceMusicMap: SourceMap;
}

type SaveState =
  | "saved"
  | "unsaved"
  | "saving"
  | "error"
  | "conflict";

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function completionIssues(brief: CreativeBriefDraft): string[] {
  const issues: string[] = [];
  const total =
    brief.contentMix.narrative +
    brief.contentMix.performance +
    brief.contentMix.abstract;

  if (!brief.objective.trim()) issues.push("Primary objective");
  if (!brief.audience.trim()) issues.push("Audience");
  if (!brief.desiredFeelings.length) issues.push("Desired feelings");
  if (!brief.tone.length) issues.push("Tone");
  if (total !== 100) issues.push("Content mix must total 100%");
  if (!brief.literalMetaphoricalMode) issues.push("Literal/metaphorical mode");
  if (!brief.artistPresence) issues.push("Artist presence");
  if (!brief.visualDialogueMode) issues.push("Image/song relationship");
  if (!brief.evolution.trim()) issues.push("Evolution across the song");
  if (!brief.endingResolution.trim()) issues.push("Ending resolution");
  return issues;
}

function LineListField(props: {
  label: string;
  value: string[];
  disabled: boolean;
  placeholder?: string;
  onChange(value: string[]): void;
}) {
  const [text, setText] = useState(props.value.join("\n"));

  useEffect(() => {
    setText(props.value.join("\n"));
  }, [props.value]);

  function commit() {
    const next = text
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 32);
    props.onChange(next);
  }

  return (
    <label>
      <span>{props.label}</span>
      <textarea
        value={text}
        rows={4}
        maxLength={5000}
        disabled={props.disabled}
        placeholder={props.placeholder ?? "One item per line"}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
      />
    </label>
  );
}

export function CreativeBriefEditor(props: {
  projectId: string;
  sourceReady: boolean;
  latestMusicMap: SourceMap | null;
  needsRebase: boolean;
  initialVersion: BriefVersion | null;
  wizardStatus: string;
  wizardLocked: boolean;
  downstreamImpact: ImpactWarning[];
}) {
  const router = useRouter();
  const [version, setVersion] = useState<BriefVersion | null>(
    props.initialVersion
  );
  const [brief, setBrief] = useState<CreativeBriefDraft | null>(
    props.initialVersion?.brief ?? null
  );
  const [status, setStatus] = useState(props.wizardStatus);
  const [locked, setLocked] = useState(props.wizardLocked);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [impactWarnings, setImpactWarnings] = useState(
    props.downstreamImpact
  );
  const [initializing, setInitializing] = useState(false);

  const revisionRef = useRef(props.initialVersion?.revision ?? 0);
  const lastSavedJsonRef = useRef(
    props.initialVersion
      ? JSON.stringify(props.initialVersion.brief)
      : ""
  );
  const latestJsonRef = useRef(lastSavedJsonRef.current);
  const savingRef = useRef(false);
  const queuedRef = useRef<{
    draft: CreativeBriefDraft;
    json: string;
  } | null>(null);

  const editable =
    Boolean(version && brief) &&
    !locked &&
    version?.lifecycle === "DRAFT" &&
    status !== "COMPLETED";

  function applyVersion(next: BriefVersion) {
    setVersion(next);
    setBrief(next.brief);
    revisionRef.current = next.revision;
    const json = JSON.stringify(next.brief);
    lastSavedJsonRef.current = json;
    latestJsonRef.current = json;
    setSaveState("saved");
  }

  async function initialize() {
    setInitializing(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/creative-brief`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "initialize" })
        }
      );
      const payload = (await response.json()) as BriefVersion & {
        error?: string;
      };
      if (!response.ok || !payload.id) {
        setMessage(payload.error ?? "Creative Brief could not be created.");
        return;
      }
      applyVersion(payload);
      setStatus("IN_PROGRESS");
      setMessage(
        "Creative Brief v" +
          payload.versionNumber +
          " created against Music Map v" +
          payload.sourceMusicMapVersionNumber +
          "."
      );
      router.refresh();
    } catch {
      setMessage("Creative Brief could not be created.");
    } finally {
      setInitializing(false);
    }
  }

  async function saveDraft(
    draft: CreativeBriefDraft,
    json: string
  ): Promise<void> {
    if (!version) return;
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
        `/api/projects/${props.projectId}/creative-brief`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            briefVersionId: version.id,
            expectedRevision: revisionRef.current,
            payload: draft
          })
        }
      );
      const result = (await response.json()) as {
        version?: BriefVersion;
        impactWarnings?: ImpactWarning[];
        error?: string;
      };

      if (!response.ok || !result.version) {
        setSaveState(response.status === 409 ? "conflict" : "error");
        setMessage(result.error ?? "Autosave failed.");
        return;
      }

      revisionRef.current = result.version.revision;
      setVersion(result.version);
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
    if (!brief) return;
    const json = JSON.stringify(brief);
    latestJsonRef.current = json;
    if (!editable || json === lastSavedJsonRef.current) return;

    setSaveState((current) =>
      current === "saving" ? current : "unsaved"
    );
    const timer = window.setTimeout(() => {
      void saveDraftRef.current(brief, json);
    }, 700);

    return () => window.clearTimeout(timer);
  }, [brief, editable, saveDraftRef]);

  async function transition(action: "complete" | "reopen" | "lock") {
    if (!version) return;
    setMessage(null);

    const response = await fetch(
      `/api/projects/${props.projectId}/creative-brief`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          briefVersionId: version.id,
          expectedRevision: revisionRef.current
        })
      }
    );
    const result = (await response.json()) as {
      version?: BriefVersion;
      impactWarnings?: ImpactWarning[];
      error?: string;
    };

    if (!response.ok || !result.version) {
      setMessage(result.error ?? "Creative Brief transition failed.");
      if (response.status === 409) setSaveState("conflict");
      return;
    }

    applyVersion(result.version);
    if (result.impactWarnings?.length) {
      setImpactWarnings(result.impactWarnings);
    }

    if (action === "complete") {
      setStatus("COMPLETED");
      setMessage("Creative Brief marked complete.");
    } else if (action === "reopen") {
      setStatus("IN_PROGRESS");
      setMessage("Creative Brief reopened for changes.");
    } else {
      setStatus("COMPLETED");
      setLocked(true);
      setMessage("Creative Brief locked for this project version.");
    }
    router.refresh();
  }

  function patch(patchValue: Partial<CreativeBriefDraft>) {
    setBrief((current) =>
      current ? { ...current, ...patchValue } : current
    );
  }

  function patchMix(
    key: keyof CreativeBriefDraft["contentMix"],
    value: number
  ) {
    setBrief((current) =>
      current
        ? {
            ...current,
            contentMix: {
              ...current.contentMix,
              [key]: Math.max(0, Math.min(100, value))
            }
          }
        : current
    );
  }

  if (!props.sourceReady) {
    return (
      <section className="briefEmpty">
        <p className="eyebrow">Prerequisite</p>
        <h2>Lock the current Music Map first</h2>
        <p>
          The Creative Brief must pin one approved musical interpretation.
          Finish and lock the Music Map so later concepts cannot drift onto an
          unapproved timing/structure version.
        </p>
        <button
          className="primaryButton"
          type="button"
          onClick={() =>
            router.push(
              `/app/projects/${props.projectId}/wizard?step=music-map` as Route
            )
          }
        >
          Go to Music Map
        </button>
      </section>
    );
  }

  if (!version || !brief) {
    return (
      <section className="briefEmpty">
        <p className="eyebrow">Creative intent</p>
        <h2>Write the Creative Brief</h2>
        <p>
          This stage records your decisions before any concept is generated.
          Nothing is preselected. PR 14 will be required to honor this brief
          when it develops concepts.
        </p>
        <button
          className="primaryButton"
          type="button"
          disabled={initializing || locked}
          onClick={() => void initialize()}
        >
          {initializing ? "Creating…" : "Start Creative Brief"}
        </button>
        {message ? <p className="wizardMessage">{message}</p> : null}
      </section>
    );
  }

  const issues = completionIssues(brief);
  const mixTotal =
    brief.contentMix.narrative +
    brief.contentMix.performance +
    brief.contentMix.abstract;
  const dirty =
    latestJsonRef.current !== lastSavedJsonRef.current;

  return (
    <div className="creativeBriefEditor">
      {props.needsRebase ? (
        <section className="impactWarning">
          <strong>New locked Music Map available</strong>
          <p>
            This brief pins Music Map v{version.sourceMusicMapVersionNumber}.
            The current map is v{props.latestMusicMap?.versionNumber}. Creating
            a new brief version keeps your authored decisions as the starting
            point while pinning the new map.
          </p>
          <button
            className="secondaryButton"
            type="button"
            disabled={locked || initializing}
            onClick={() => void initialize()}
          >
            Create brief version on latest map
          </button>
        </section>
      ) : null}

      {impactWarnings.length ? (
        <section className="impactWarning">
          <strong>Downstream impact</strong>
          <p>
            Changing this brief will mark already-touched later creative work
            for review:
          </p>
          <ul>
            {impactWarnings.map((warning) => (
              <li key={warning.stepKey}>
                {warning.title}
                {warning.locked ? " (locked content preserved)" : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="briefHeader">
        <div>
          <p className="eyebrow">Creative Brief v{version.versionNumber}</p>
          <h2>Your creative constraints before concepts</h2>
          <p>
            Pinned to Music Map v{version.sourceMusicMapVersionNumber}. The
            brief is authored by you; the system does not choose these values.
          </p>
        </div>
        <div className="autosaveStatus" aria-live="polite">
          <span className={"autosaveDot autosaveDot-" + saveState} />
          {saveState === "saved"
            ? "All changes saved"
            : saveState === "saving"
              ? "Saving…"
              : saveState === "unsaved"
                ? "Unsaved changes"
                : saveState === "conflict"
                  ? "Another request changed this brief — reload required"
                  : "Autosave error"}
        </div>
      </div>

      <section className="briefSourceMap">
        <div>
          <span>Music Map</span>
          <strong>v{version.sourceMusicMap.versionNumber}</strong>
        </div>
        <div>
          <span>Tempo</span>
          <strong>
            {version.sourceMusicMap.tempoBpm?.toFixed(1) ?? "—"} BPM
          </strong>
        </div>
        <div>
          <span>Meter</span>
          <strong>
            {version.sourceMusicMap.meterNumerator}/
            {version.sourceMusicMap.meterDenominator}
          </strong>
        </div>
        <div>
          <span>Accepted anchors</span>
          <strong>{version.sourceMusicMap.acceptedAnchors.length}</strong>
        </div>
      </section>

      {version.sourceMusicMap.acceptedAnchors.length ? (
        <section className="briefAnchorContext">
          <p className="eyebrow">Approved musical anchors</p>
          <div>
            {version.sourceMusicMap.acceptedAnchors.slice(0, 12).map((anchor) => (
              <span key={anchor.id}>
                {clock(anchor.startMs)} · {anchor.label}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="briefPanel">
        <div className="briefPanelHeading">
          <p className="eyebrow">Purpose</p>
          <h3>What must this video accomplish?</h3>
        </div>
        <div className="briefTwoColumn">
          <label>
            <span>Primary objective</span>
            <textarea
              value={brief.objective}
              rows={5}
              maxLength={6000}
              disabled={!editable}
              placeholder="What should the finished video do artistically, emotionally, narratively, or commercially?"
              onChange={(event) => patch({ objective: event.target.value })}
            />
          </label>
          <label>
            <span>Intended audience</span>
            <textarea
              value={brief.audience}
              rows={5}
              maxLength={3000}
              disabled={!editable}
              placeholder="Who is this for, and what should they bring away from it?"
              onChange={(event) => patch({ audience: event.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="briefPanel">
        <div className="briefPanelHeading">
          <p className="eyebrow">Emotional target</p>
          <h3>How should it feel?</h3>
        </div>
        <div className="briefTwoColumn">
          <LineListField
            label="Desired feelings"
            value={brief.desiredFeelings}
            disabled={!editable}
            placeholder="One feeling per line"
            onChange={(value) => patch({ desiredFeelings: value })}
          />
          <LineListField
            label="Tone"
            value={brief.tone}
            disabled={!editable}
            placeholder="One tonal quality per line"
            onChange={(value) => patch({ tone: value })}
          />
        </div>
      </section>

      <section className="briefPanel">
        <div className="briefPanelHeading briefPanelHeadingSplit">
          <div>
            <p className="eyebrow">Form</p>
            <h3>Narrative / performance / abstract mix</h3>
          </div>
          <strong className={mixTotal === 100 ? "mixTotalValid" : "mixTotalInvalid"}>
            {mixTotal}% total
          </strong>
        </div>
        <div className="briefMixGrid">
          {(["narrative", "performance", "abstract"] as const).map((key) => (
            <label key={key}>
              <span>{key[0]!.toUpperCase() + key.slice(1)} %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={brief.contentMix[key]}
                disabled={!editable}
                onChange={(event) =>
                  patchMix(key, Number(event.target.value))
                }
              />
            </label>
          ))}
        </div>
        <p className="dashboardNote">
          These percentages are intentionally not auto-balanced. Set the mix
          you actually want; completion requires exactly 100%.
        </p>
      </section>

      <section className="briefPanel">
        <div className="briefThreeColumn">
          <label>
            <span>Literal ↔ metaphorical</span>
            <select
              value={brief.literalMetaphoricalMode ?? ""}
              disabled={!editable}
              onChange={(event) =>
                patch({
                  literalMetaphoricalMode:
                    (event.target.value ||
                      null) as CreativeBriefDraft["literalMetaphoricalMode"]
                })
              }
            >
              <option value="">Choose…</option>
              <option value="LITERAL">Literal</option>
              <option value="MOSTLY_LITERAL">Mostly literal</option>
              <option value="BALANCED">Balanced</option>
              <option value="MOSTLY_METAPHORICAL">Mostly metaphorical</option>
              <option value="METAPHORICAL">Metaphorical</option>
            </select>
          </label>

          <label>
            <span>Artist presence</span>
            <select
              value={brief.artistPresence ?? ""}
              disabled={!editable}
              onChange={(event) =>
                patch({
                  artistPresence:
                    (event.target.value ||
                      null) as CreativeBriefDraft["artistPresence"]
                })
              }
            >
              <option value="">Choose…</option>
              <option value="NONE">No artist appearance</option>
              <option value="CAMEO">Cameo</option>
              <option value="PERFORMANCE">Performance</option>
              <option value="NARRATIVE_CHARACTER">Narrative character</option>
              <option value="MIXED">Mixed role</option>
              <option value="CENTRAL">Central focus</option>
            </select>
          </label>

          <label>
            <span>Images vs. song / lyrics</span>
            <select
              value={brief.visualDialogueMode ?? ""}
              disabled={!editable}
              onChange={(event) =>
                patch({
                  visualDialogueMode:
                    (event.target.value ||
                      null) as CreativeBriefDraft["visualDialogueMode"]
                })
              }
            >
              <option value="">Choose…</option>
              <option value="ILLUSTRATIVE">Illustrative</option>
              <option value="COMPLEMENTARY">Complementary</option>
              <option value="COUNTERPOINT">Counterpoint / contrast</option>
              <option value="ABSTRACT_ASSOCIATIVE">Abstract / associative</option>
              <option value="MIXED">Mixed strategy</option>
            </select>
          </label>
        </div>

        <div className="briefThreeColumn briefNotesGrid">
          <label>
            <span>Literal/metaphorical notes</span>
            <textarea
              value={brief.literalMetaphoricalNotes}
              rows={4}
              maxLength={4000}
              disabled={!editable}
              onChange={(event) =>
                patch({ literalMetaphoricalNotes: event.target.value })
              }
            />
          </label>
          <label>
            <span>Artist-presence notes</span>
            <textarea
              value={brief.artistPresenceNotes}
              rows={4}
              maxLength={4000}
              disabled={!editable}
              onChange={(event) =>
                patch({ artistPresenceNotes: event.target.value })
              }
            />
          </label>
          <label>
            <span>Visual-dialogue notes</span>
            <textarea
              value={brief.visualDialogueNotes}
              rows={4}
              maxLength={4000}
              disabled={!editable}
              onChange={(event) =>
                patch({ visualDialogueNotes: event.target.value })
              }
            />
          </label>
        </div>
      </section>

      <section className="briefPanel">
        <div className="briefPanelHeading">
          <p className="eyebrow">Non-negotiables</p>
          <h3>Required and forbidden imagery</h3>
        </div>
        <div className="briefTwoColumn">
          <LineListField
            label="Must include"
            value={brief.requiredImagery}
            disabled={!editable}
            onChange={(value) => patch({ requiredImagery: value })}
          />
          <LineListField
            label="Must avoid"
            value={brief.avoidedImagery}
            disabled={!editable}
            onChange={(value) => patch({ avoidedImagery: value })}
          />
        </div>
      </section>

      <section className="briefPanel">
        <div className="briefPanelHeading">
          <p className="eyebrow">Arc</p>
          <h3>How does the experience change?</h3>
        </div>
        <div className="briefTwoColumn">
          <label>
            <span>Evolution across the song</span>
            <textarea
              value={brief.evolution}
              rows={6}
              maxLength={6000}
              disabled={!editable}
              placeholder="Describe escalation, transformation, contrast, reversals, or changes in visual logic."
              onChange={(event) => patch({ evolution: event.target.value })}
            />
          </label>
          <label>
            <span>Ending / resolution</span>
            <textarea
              value={brief.endingResolution}
              rows={6}
              maxLength={6000}
              disabled={!editable}
              placeholder="Resolved, ambiguous, circular, triumphant, tragic, reveal, rupture, etc."
              onChange={(event) =>
                patch({ endingResolution: event.target.value })
              }
            />
          </label>
        </div>
      </section>

      <section className="briefPanel">
        <div className="briefTwoColumn">
          <LineListField
            label="Recurring symbols / motifs"
            value={brief.recurringSymbols}
            disabled={!editable}
            onChange={(value) => patch({ recurringSymbols: value })}
          />
          <LineListField
            label="Cultural / period influences"
            value={brief.culturalPeriodInfluences}
            disabled={!editable}
            onChange={(value) =>
              patch({ culturalPeriodInfluences: value })
            }
          />
          <LineListField
            label="References"
            value={brief.references}
            disabled={!editable}
            placeholder="Films, paintings, photographers, videos, places, eras, objects—one per line"
            onChange={(value) => patch({ references: value })}
          />
          <LineListField
            label="Constraints"
            value={brief.constraints}
            disabled={!editable}
            placeholder="Production, content, continuity, legal, format, or other constraints—one per line"
            onChange={(value) => patch({ constraints: value })}
          />
        </div>

        <label className="briefFullWidth">
          <span>Additional notes</span>
          <textarea
            value={brief.notes}
            rows={5}
            maxLength={8000}
            disabled={!editable}
            onChange={(event) => patch({ notes: event.target.value })}
          />
        </label>
      </section>

      {message ? <p className="wizardMessage">{message}</p> : null}

      {status !== "COMPLETED" && !locked && issues.length ? (
        <section className="briefCompletionIssues">
          <strong>Still required before completion</strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      ) : null}

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
              Lock Creative Brief
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
              issues.length > 0
            }
            onClick={() => void transition("complete")}
          >
            Mark Creative Brief complete
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
