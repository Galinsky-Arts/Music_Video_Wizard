"use client";

import type { Route } from "next";
import { useEffect, useMemo, useState } from "react";
import { useLatest } from "./use-latest";
import { useRouter } from "next/navigation";
import type { CreativeBriefDraft } from "@/lib/creative-brief/input";
import type { ConceptContent } from "@/lib/concepts/schema";

interface ImpactWarning {
  stepKey: string;
  title: string;
  locked: boolean;
}

interface ConceptOptionView {
  id: string;
  origin: string;
  position: number;
  content: ConceptContent;
  generationJobId: string | null;
  revisionInstruction: string | null;
  createdAt: string | Date;
  parents: Array<{
    role: string;
    position: number;
    parentConceptId: string;
  }>;
}

interface ConceptSetView {
  id: string;
  nodeId: string;
  versionNumber: number;
  lifecycle: "DRAFT" | "LOCKED" | "SUPERSEDED";
  sourceCreativeBriefVersionId: string;
  sourceCreativeBriefVersionNumber: number;
  revision: number;
  selectedConceptId: string | null;
  createdAt: string | Date;
  lockedAt: string | Date | null;
  creativeBrief: CreativeBriefDraft;
  musicMap: {
    versionNumber: number;
    durationMs: number;
    tempoBpm: number | null;
    meterNumerator: number;
    meterDenominator: number;
    acceptedAnchors: Array<{
      kind: string;
      label: string;
      startMs: number;
      endMs: number | null;
    }>;
  };
  options: ConceptOptionView[];
}

type JobView = {
  id: string;
  status: string;
  progressPercent: number;
  progressMessage: string | null;
  errorMessage: string | null;
} | null;

const ALIGNMENT_LABELS: Array<
  keyof ConceptContent["briefAlignment"]
> = ["objective", "emotion", "form", "imagery", "constraints"];

function human(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function ConceptCard(props: {
  option: ConceptOptionView;
  selected: boolean;
  checked: boolean;
  disabled: boolean;
  revisionInstruction: string;
  onChecked(checked: boolean): void;
  onRevisionInstruction(value: string): void;
  onRevise(): void;
  onSelect(): void;
}) {
  const c = props.option.content;
  return (
    <article
      className={
        "conceptCard" +
        (props.selected ? " conceptCardSelected" : "")
      }
    >
      <div className="conceptCardTop">
        <div>
          <div className="conceptMeta">
            <span>Concept {props.option.position + 1}</span>
            <span>{human(props.option.origin)}</span>
            {props.selected ? <strong>Selected</strong> : null}
          </div>
          <h3>{c.title}</h3>
          <p className="conceptLogline">{c.logline}</p>
        </div>
        <label className="conceptCompareCheck">
          <input
            type="checkbox"
            checked={props.checked}
            disabled={props.disabled}
            onChange={(event) => props.onChecked(event.target.checked)}
          />
          Compare / combine
        </label>
      </div>

      <details open={props.selected}>
        <summary>Complete concept</summary>
        <div className="conceptDetailGrid">
          <section>
            <h4>Central premise</h4>
            <p>{c.centralPremise}</p>
          </section>
          <section>
            <h4>Synopsis</h4>
            <p>{c.synopsis}</p>
          </section>
          <section>
            <h4>Visual world</h4>
            <p>{c.visualWorld}</p>
          </section>
          <section>
            <h4>Narrative approach</h4>
            <p>{c.narrativeApproach}</p>
          </section>
          <section>
            <h4>Performance approach</h4>
            <p>{c.performanceApproach}</p>
          </section>
          <section>
            <h4>Abstract approach</h4>
            <p>{c.abstractApproach}</p>
          </section>
          <section>
            <h4>Artist role</h4>
            <p>{c.artistRole}</p>
          </section>
          <section>
            <h4>Relationship to the song</h4>
            <p>{c.relationshipToSong}</p>
          </section>
          <section>
            <h4>Emotional arc</h4>
            <p>{c.emotionalArc}</p>
          </section>
          <section>
            <h4>Musical arc</h4>
            <p>{c.musicalArc}</p>
          </section>
          <section>
            <h4>Ending image</h4>
            <p>{c.endingImage}</p>
          </section>
          <section>
            <h4>Production logic</h4>
            <p>{c.productionLogic}</p>
          </section>
        </div>

        <div className="conceptListColumns">
          <section>
            <h4>Distinctive images</h4>
            <ul>{c.distinctiveImages.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
          <section>
            <h4>Recurring motifs</h4>
            <ul>{c.recurringMotifs.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
          <section>
            <h4>Strengths</h4>
            <ul>{c.strengths.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
          <section>
            <h4>Risks</h4>
            <ul>{c.risks.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
        </div>

        <section className="conceptContrast">
          <h4>What distinguishes it</h4>
          <p>{c.contrastStatement}</p>
        </section>

        <section className="conceptAlignment">
          <h4>Model assessment against the locked brief</h4>
          <p className="dashboardNote">
            This is an analytic explanation from the generation model, not an
            objective score. You decide whether the concept actually fits.
          </p>
          <div>
            {ALIGNMENT_LABELS.map((key) => {
              const item = c.briefAlignment[key];
              return (
                <article key={key}>
                  <span>{human(key)}</span>
                  <strong>{human(item.rating)}</strong>
                  <p>{item.rationale}</p>
                </article>
              );
            })}
          </div>
        </section>
      </details>

      {!props.disabled ? (
        <div className="conceptCardActions">
          <button
            className={props.selected ? "primaryButton" : "secondaryButton"}
            type="button"
            disabled={props.selected}
            onClick={props.onSelect}
          >
            {props.selected ? "Selected direction" : "Select this concept"}
          </button>
          <div className="conceptRevisionControl">
            <input
              value={props.revisionInstruction}
              placeholder="How should this concept change?"
              maxLength={5000}
              onChange={(event) =>
                props.onRevisionInstruction(event.target.value)
              }
            />
            <button
              className="secondaryButton"
              type="button"
              disabled={!props.revisionInstruction.trim()}
              onClick={props.onRevise}
            >
              Generate revision
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function ConceptsEditor(props: {
  projectId: string;
  sourceReady: boolean;
  latestBriefVersionNumber: number | null;
  needsRebase: boolean;
  initialSet: ConceptSetView | null;
  recentJob: JobView;
  providerAvailable: boolean;
  wizardStatus: string;
  wizardLocked: boolean;
  downstreamImpact: ImpactWarning[];
}) {
  const router = useRouter();
  const [set, setSet] = useState<ConceptSetView | null>(props.initialSet);
  const [job, setJob] = useState<JobView>(props.recentJob);
  const [status, setStatus] = useState(props.wizardStatus);
  const [locked, setLocked] = useState(props.wizardLocked);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [batchCount, setBatchCount] = useState(4);
  const [batchDirection, setBatchDirection] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [combineInstruction, setCombineInstruction] = useState("");
  const [revisionInstructions, setRevisionInstructions] =
    useState<Record<string, string>>({});
  const [impactWarnings, setImpactWarnings] = useState(
    props.downstreamImpact
  );

  const active =
    job?.status === "QUEUED" || job?.status === "RUNNING";
  const disabled =
    locked || set?.lifecycle === "LOCKED" || active || busy;

  const compare = useMemo(
    () =>
      set?.options.filter((option) =>
        compareIds.includes(option.id)
      ) ?? [],
    [set, compareIds]
  );

  async function refreshState() {
    const response = await fetch(
      `/api/projects/${props.projectId}/concepts`,
      { cache: "no-store" }
    );
    if (!response.ok) return;
    const state = (await response.json()) as {
      latest: ConceptSetView | null;
      recentJob: JobView;
    };
    if (state.latest) setSet(state.latest);
    setJob(state.recentJob);
  }

  const refreshStateRef=useLatest(refreshState);
  useEffect(() => {
    if (!active || !job) return;
    const timer = window.setInterval(async () => {
      const response = await fetch("/api/jobs/" + job.id, {
        cache: "no-store"
      });
      if (!response.ok) return;
      const next = (await response.json()) as NonNullable<JobView>;
      setJob(next);

      if (
        next.status === "SUCCEEDED" ||
        next.status === "FAILED" ||
        next.status === "CANCELLED"
      ) {
        window.clearInterval(timer);
        await refreshStateRef.current();
        if (next.status === "SUCCEEDED") {
          setStatus("IN_PROGRESS");
          setMessage("Concept generation completed.");
        }
        router.refresh();
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [active, job, router, refreshStateRef]);

  async function initialize() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/concepts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "initialize" })
        }
      );
      const payload = (await response.json()) as ConceptSetView & {
        error?: string;
      };
      if (!response.ok || !payload.id) {
        setMessage(payload.error ?? "Concept set could not be created.");
        return;
      }
      setSet(payload);
      setStatus("IN_PROGRESS");
      setCompareIds([]);
      setMessage(
        "Concept Set v" +
          payload.versionNumber +
          " created against Creative Brief v" +
          payload.sourceCreativeBriefVersionNumber +
          "."
      );
      router.refresh();
    } catch {
      setMessage("Concept set could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function queueGeneration(
    body:
      | {
          operation: "generate";
          count: number;
          direction: string;
        }
      | {
          operation: "revise";
          parentConceptId: string;
          instruction: string;
        }
      | {
          operation: "combine";
          parentConceptIds: string[];
          instruction: string;
        }
  ) {
    if (!set) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/concepts/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conceptSetVersionId: set.id,
            expectedRevision: set.revision,
            ...body
          })
        }
      );
      const result = (await response.json()) as {
        jobId?: string;
        status?: string;
        error?: string;
      };
      if (!response.ok || !result.jobId) {
        setMessage(
          result.error ?? "Concept generation could not be queued."
        );
        return;
      }
      setJob({
        id: result.jobId,
        status: result.status ?? "QUEUED",
        progressPercent: 0,
        progressMessage: "Queued.",
        errorMessage: null
      });
      setStatus("IN_PROGRESS");
      setMessage(null);
    } catch {
      setMessage("Concept generation could not be queued.");
    } finally {
      setBusy(false);
    }
  }

  async function select(conceptId: string) {
    if (!set) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/concepts/select`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conceptSetVersionId: set.id,
            expectedRevision: set.revision,
            conceptId
          })
        }
      );
      const result = (await response.json()) as {
        version?: ConceptSetView;
        impactWarnings?: ImpactWarning[];
        error?: string;
      };
      if (!response.ok || !result.version) {
        setMessage(result.error ?? "Concept selection failed.");
        return;
      }
      setSet(result.version);
      setStatus("IN_PROGRESS");
      if (result.impactWarnings?.length) {
        setImpactWarnings(result.impactWarnings);
      }
      setMessage("Selected concept updated.");
    } finally {
      setBusy(false);
    }
  }

  async function transition(action: "complete" | "reopen" | "lock") {
    if (!set) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/concepts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            conceptSetVersionId: set.id,
            expectedRevision: set.revision
          })
        }
      );
      const result = (await response.json()) as {
        version?: ConceptSetView;
        impactWarnings?: ImpactWarning[];
        error?: string;
      };
      if (!response.ok || !result.version) {
        setMessage(result.error ?? "Concept stage transition failed.");
        return;
      }
      setSet(result.version);
      if (result.impactWarnings?.length) {
        setImpactWarnings(result.impactWarnings);
      }
      if (action === "complete") {
        setStatus("COMPLETED");
        setMessage("Selected concept approved for Treatment.");
      } else if (action === "reopen") {
        setStatus("IN_PROGRESS");
        setMessage("Concept development reopened.");
      } else {
        setStatus("COMPLETED");
        setLocked(true);
        setMessage("Concept direction locked for this project version.");
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    const response = await fetch(
      "/api/jobs/" + job.id + "/cancel",
      { method: "POST" }
    );
    if (response.ok) {
      setJob({
        ...job,
        status: "CANCELLED",
        progressMessage: "Cancelled."
      });
      setMessage("Concept generation cancelled.");
    }
  }

  if (!props.sourceReady) {
    return (
      <section className="conceptEmpty">
        <p className="eyebrow">Prerequisite</p>
        <h2>Lock the Creative Brief first</h2>
        <p>
          Concept generation is governed by one exact approved brief. Finish
          and lock it before asking the system to propose directions.
        </p>
        <button
          className="primaryButton"
          type="button"
          onClick={() =>
            router.push(
              `/app/projects/${props.projectId}/wizard?step=creative-brief` as Route
            )
          }
        >
          Go to Creative Brief
        </button>
      </section>
    );
  }

  if (!set) {
    return (
      <section className="conceptEmpty">
        <p className="eyebrow">Concept development</p>
        <h2>Develop complete alternatives before committing</h2>
        <p>
          Start a versioned concept set pinned to Creative Brief v
          {props.latestBriefVersionNumber}. Generated alternatives remain
          separate, revisable options until you explicitly select one.
        </p>
        <button
          className="primaryButton"
          type="button"
          disabled={busy || locked}
          onClick={() => void initialize()}
        >
          {busy ? "Creating…" : "Start Concepts"}
        </button>
        {message ? <p className="wizardMessage">{message}</p> : null}
      </section>
    );
  }

  return (
    <div className="conceptsEditor">
      {props.needsRebase ? (
        <section className="impactWarning">
          <strong>New locked Creative Brief available</strong>
          <p>
            This concept set pins Creative Brief v
            {set.sourceCreativeBriefVersionNumber}. Create a new concept-set
            version to develop directions against brief v
            {props.latestBriefVersionNumber}.
          </p>
          <button
            className="secondaryButton"
            type="button"
            disabled={disabled}
            onClick={() => void initialize()}
          >
            Start concepts on latest brief
          </button>
        </section>
      ) : null}

      {impactWarnings.length ? (
        <section className="impactWarning">
          <strong>Downstream impact</strong>
          <p>
            Changing the selected concept affects already-touched later work:
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

      <section className="conceptBriefSummary">
        <div>
          <p className="eyebrow">
            Concept Set v{set.versionNumber} · Creative Brief v
            {set.sourceCreativeBriefVersionNumber}
          </p>
          <h2>Compare complete directions</h2>
          <p>{set.creativeBrief.objective}</p>
        </div>
        <div className="conceptBriefFacts">
          <span>
            Feelings: {set.creativeBrief.desiredFeelings.join(", ")}
          </span>
          <span>Tone: {set.creativeBrief.tone.join(", ")}</span>
          <span>
            Form: {set.creativeBrief.contentMix.narrative}% narrative ·{" "}
            {set.creativeBrief.contentMix.performance}% performance ·{" "}
            {set.creativeBrief.contentMix.abstract}% abstract
          </span>
        </div>
      </section>

      {active && job ? (
        <section className="analysisProgress" aria-live="polite">
          <div className="analysisProgressHeader">
            <strong>
              {job.progressMessage || "Developing concepts…"}
            </strong>
            <span>{job.progressPercent}%</span>
          </div>
          <div className="analysisProgressTrack">
            <div style={{ width: job.progressPercent + "%" }} />
          </div>
          <button
            className="textButton"
            type="button"
            onClick={() => void cancelJob()}
          >
            Cancel generation
          </button>
        </section>
      ) : null}

      {job?.status === "FAILED" ? (
        <p className="formError">
          Concept generation failed:{" "}
          {job.errorMessage || "Unknown error"}
        </p>
      ) : null}

      {!locked ? (
        <section className="conceptGenerationPanel">
          <div>
            <p className="eyebrow">Generate alternatives</p>
            <h3>Ask for a deliberately varied batch</h3>
          </div>
          {!props.providerAvailable ? (
            <p className="formError">
              No text-generation provider is configured. Set
              TEXT_GENERATION_PROVIDER and its credentials before generating
              concepts.
            </p>
          ) : null}
          <div className="conceptGenerationControls">
            <label>
              <span>Number of concepts</span>
              <select
                value={batchCount}
                disabled={disabled}
                onChange={(event) =>
                  setBatchCount(Number(event.target.value))
                }
              >
                {[2, 3, 4, 5, 6].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label className="conceptDirectionField">
              <span>Optional direction for this batch</span>
              <textarea
                rows={3}
                maxLength={4000}
                value={batchDirection}
                disabled={disabled}
                placeholder="Example: push one option toward surreal spectacle, but keep all brief constraints."
                onChange={(event) =>
                  setBatchDirection(event.target.value)
                }
              />
            </label>
            <button
              className="primaryButton"
              type="button"
              disabled={disabled || !props.providerAvailable}
              onClick={() =>
                void queueGeneration({
                  operation: "generate",
                  count: batchCount,
                  direction: batchDirection
                })
              }
            >
              Generate concept batch
            </button>
          </div>
        </section>
      ) : null}

      {compare.length >= 2 ? (
        <section className="conceptComparePanel">
          <div className="analysisSectionHeading">
            <div>
              <p className="eyebrow">Direct comparison</p>
              <h3>
                {compare.map((option) => option.content.title).join(" vs. ")}
              </h3>
            </div>
          </div>
          <div
            className="conceptCompareGrid"
            style={{
              gridTemplateColumns:
                "repeat(" + compare.length + ", minmax(230px, 1fr))"
            }}
          >
            {compare.map((option) => (
              <article key={option.id}>
                <h4>{option.content.title}</h4>
                <p>{option.content.logline}</p>
                <strong>Emotional arc</strong>
                <p>{option.content.emotionalArc}</p>
                <strong>Visual world</strong>
                <p>{option.content.visualWorld}</p>
                <strong>Ending</strong>
                <p>{option.content.endingImage}</p>
                <strong>Primary risk</strong>
                <p>{option.content.risks[0]}</p>
              </article>
            ))}
          </div>
          {!locked ? (
            <div className="conceptCombineControl">
              <textarea
                rows={3}
                maxLength={5000}
                disabled={disabled}
                value={combineInstruction}
                placeholder="Optional: say which elements to preserve, reject, or reconcile."
                onChange={(event) =>
                  setCombineInstruction(event.target.value)
                }
              />
              <button
                className="secondaryButton"
                type="button"
                disabled={disabled}
                onClick={() =>
                  void queueGeneration({
                    operation: "combine",
                    parentConceptIds: compare.map(
                      (option) => option.id
                    ),
                    instruction: combineInstruction
                  })
                }
              >
                Generate combined concept
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="conceptCardList">
        {set.options.map((option) => (
          <ConceptCard
            key={option.id}
            option={option}
            selected={set.selectedConceptId === option.id}
            checked={compareIds.includes(option.id)}
            disabled={disabled}
            revisionInstruction={
              revisionInstructions[option.id] ?? ""
            }
            onChecked={(checked) =>
              setCompareIds((current) =>
                checked
                  ? current.includes(option.id)
                    ? current
                    : [...current, option.id].slice(-4)
                  : current.filter((id) => id !== option.id)
              )
            }
            onRevisionInstruction={(value) =>
              setRevisionInstructions((current) => ({
                ...current,
                [option.id]: value
              }))
            }
            onRevise={() =>
              void queueGeneration({
                operation: "revise",
                parentConceptId: option.id,
                instruction:
                  revisionInstructions[option.id] ?? ""
              })
            }
            onSelect={() => void select(option.id)}
          />
        ))}
      </div>

      {set.options.length === 0 && !active ? (
        <section className="conceptEmpty">
          <h3>No concepts yet.</h3>
          <p>
            Generate at least two alternatives. They will remain independent
            options until you choose a direction.
          </p>
        </section>
      ) : null}

      {message ? <p className="wizardMessage">{message}</p> : null}

      <section className="mapCompletionPanel">
        <div>
          <strong>
            {set.selectedConceptId
              ? status === "COMPLETED"
                ? "Concept direction approved"
                : "A concept is selected"
              : "Select one concept to proceed"}
          </strong>
          <p>
            Treatment will pin the exact selected concept. Generating,
            revising, or combining other alternatives does not silently change
            the selected direction.
          </p>
        </div>
        <div className="mapPanelActions">
          {status !== "COMPLETED" && !locked ? (
            <button
              className="primaryButton"
              type="button"
              disabled={
                disabled || !set.selectedConceptId
              }
              onClick={() => void transition("complete")}
            >
              Approve selected concept
            </button>
          ) : null}
          {status === "COMPLETED" && !locked ? (
            <>
              <button
                className="secondaryButton"
                type="button"
                disabled={busy || active}
                onClick={() => void transition("reopen")}
              >
                Reopen concept development
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={busy || active}
                onClick={() => void transition("lock")}
              >
                Lock concept direction
              </button>
            </>
          ) : null}
          {locked ? (
            <span className="wizardLockedLabel">
              Locked in this project version
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
