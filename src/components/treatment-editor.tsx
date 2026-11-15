"use client";

import { useEffect, useState } from "react";
import { useLatest } from "./use-latest";
import { useRouter } from "next/navigation";

type Section = {
  title: string;
  startMs: number;
  endMs: number;
  musicAnchorLabels: string[];
  dramaticPurpose: string;
  picturePlan: string;
  narrativeProgression: string;
  performancePlan: string;
  visualProgression: string;
  characterProgression: string;
  worldChange: string;
  motifs: string[];
  majorReveal: string;
  transitionIntent: string;
};

type Draft = {
  title: string;
  thesis: string;
  overview: string;
  narrativeArc: string;
  visualArc: string;
  characterArc: string;
  performanceStrategy: string;
  worldEvolution: string;
  motifStrategy: string;
  revealStrategy: string;
  ending: string;
  sections: Section[];
};

type TreatmentView = {
  id: string;
  versionNumber: number;
  lifecycle: string;
  revision: number;
  sourceConceptSetVersionNumber: number;
  sourceConceptId: string;
  selectedConcept: { title: string; logline: string };
  musicMap: {
    durationMs: number;
    anchors: Array<{ id: string; kind: string; label: string; startMs: number; endMs: number | null }>;
  };
  treatment: Draft;
  generationJobId: string | null;
};

type JobView = {
  id: string;
  status: string;
  progressPercent: number;
  progressMessage: string | null;
  errorMessage: string | null;
} | null;

type ImpactWarning = { stepKey: string; title: string; locked: boolean; status?: string };

const TOP_FIELDS: Array<[keyof Omit<Draft, "sections">, string]> = [
  ["title", "Treatment title"],
  ["thesis", "Thesis"],
  ["overview", "Overview"],
  ["narrativeArc", "Narrative arc"],
  ["visualArc", "Visual arc"],
  ["characterArc", "Character arc"],
  ["performanceStrategy", "Performance strategy"],
  ["worldEvolution", "World evolution"],
  ["motifStrategy", "Motif strategy"],
  ["revealStrategy", "Reveal strategy"],
  ["ending", "Ending"]
];

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return minutes + ":" + seconds;
}

function emptySection(durationMs: number): Section {
  return {
    title: "",
    startMs: 0,
    endMs: durationMs,
    musicAnchorLabels: [],
    dramaticPurpose: "",
    picturePlan: "",
    narrativeProgression: "",
    performancePlan: "",
    visualProgression: "",
    characterProgression: "",
    worldChange: "",
    motifs: [],
    majorReveal: "",
    transitionIntent: ""
  };
}

export function TreatmentEditor(props: {
  projectId: string;
  sourceReady: boolean;
  needsRebase: boolean;
  initialVersion: TreatmentView | null;
  recentJob: JobView;
  providerAvailable: boolean;
  wizardStatus: string;
  wizardLocked: boolean;
  downstreamImpact: ImpactWarning[];
}) {
  const router = useRouter();
  const [version, setVersion] = useState<TreatmentView | null>(props.initialVersion);
  const [draft, setDraft] = useState<Draft | null>(props.initialVersion?.treatment ?? null);
  const [job, setJob] = useState<JobView>(props.recentJob);
  const [status, setStatus] = useState(props.wizardStatus);
  const [locked, setLocked] = useState(props.wizardLocked);
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [impact, setImpact] = useState(props.downstreamImpact);

  const active = job?.status === "QUEUED" || job?.status === "RUNNING";
  const disabled = busy || active || locked || version?.lifecycle === "LOCKED";

  async function refreshState() {
    const response = await fetch(`/api/projects/${props.projectId}/treatment`, { cache: "no-store" });
    if (!response.ok) return;
    const state = await response.json() as { latest: TreatmentView | null; recentJob: JobView };
    if (state.latest) {
      setVersion(state.latest);
      setDraft(state.latest.treatment);
      setDirty(false);
    }
    setJob(state.recentJob);
  }

  const refreshStateRef=useLatest(refreshState);
  useEffect(() => {
    if (!active || !job) return;
    const timer = window.setInterval(async () => {
      const response = await fetch("/api/jobs/" + job.id, { cache: "no-store" });
      if (!response.ok) return;
      const next = await response.json() as NonNullable<JobView>;
      setJob(next);
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(next.status)) {
        window.clearInterval(timer);
        await refreshStateRef.current();
        if (next.status === "SUCCEEDED") {
          setStatus("IN_PROGRESS");
          setMessage("Treatment generation completed. Review and edit it before completion.");
        } else {
          setMessage(next.errorMessage ?? "Treatment generation did not complete.");
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
      const response = await fetch(`/api/projects/${props.projectId}/treatment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "initialize" })
      });
      const payload = await response.json() as TreatmentView & { error?: string };
      if (!response.ok || !payload.id) {
        setMessage(payload.error ?? "Treatment could not be initialized.");
        return;
      }
      setVersion(payload);
      setDraft(payload.treatment);
      setStatus("IN_PROGRESS");
      setDirty(false);
      setMessage("Treatment v" + payload.versionNumber + " created from Concept Set v" + payload.sourceConceptSetVersionNumber + ".");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!version || !draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${props.projectId}/treatment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          treatmentVersionId: version.id,
          expectedRevision: version.revision,
          treatment: draft
        })
      });
      const result = await response.json() as { version?: TreatmentView; impactWarnings?: ImpactWarning[]; error?: string };
      if (!response.ok || !result.version) {
        setMessage(result.error ?? "Treatment could not be saved.");
        return;
      }
      setVersion(result.version);
      setDraft(result.version.treatment);
      setDirty(false);
      setStatus("IN_PROGRESS");
      if (result.impactWarnings?.length) setImpact(result.impactWarnings);
      setMessage("Treatment saved.");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!version) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${props.projectId}/treatment/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          treatmentVersionId: version.id,
          expectedRevision: version.revision,
          direction
        })
      });
      const result = await response.json() as { jobId?: string; status?: string; error?: string };
      if (!response.ok || !result.jobId) {
        setMessage(result.error ?? "Treatment generation could not be queued.");
        return;
      }
      setJob({
        id: result.jobId,
        status: result.status ?? "QUEUED",
        progressPercent: 0,
        progressMessage: "Queued.",
        errorMessage: null
      });
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }

  async function transition(action: "complete" | "reopen" | "lock") {
    if (!version) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${props.projectId}/treatment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          treatmentVersionId: version.id,
          expectedRevision: version.revision
        })
      });
      const result = await response.json() as { version?: TreatmentView; impactWarnings?: ImpactWarning[]; error?: string };
      if (!response.ok || !result.version) {
        setMessage(result.error ?? "Treatment transition failed.");
        return;
      }
      setVersion(result.version);
      setDraft(result.version.treatment);
      if (result.impactWarnings?.length) setImpact(result.impactWarnings);
      if (action === "complete") setStatus("COMPLETED");
      if (action === "reopen") setStatus("IN_PROGRESS");
      if (action === "lock") setLocked(true);
      setMessage(action === "lock" ? "Treatment locked." : action === "complete" ? "Treatment completed." : "Treatment reopened.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function setTop(key: keyof Omit<Draft, "sections">, value: string) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
    setDirty(true);
  }

  function updateSection(index: number, patch: Partial<Section>) {
    if (!draft) return;
    const sections = draft.sections.map((section, i) => i === index ? { ...section, ...patch } : section);
    setDraft({ ...draft, sections });
    setDirty(true);
  }

  if (!props.sourceReady) {
    return <div className="treatmentEmpty"><h2>Treatment is waiting for a locked concept</h2><p>Select, complete, and lock the concept direction before expanding it into a treatment.</p></div>;
  }

  if (!version || !draft) {
    return (
      <div className="treatmentEmpty">
        <p className="eyebrow">PR 15 · Treatment</p>
        <h2>Expand the selected concept across the finished song</h2>
        <p>The treatment becomes the authoritative dramatic and visual plan for later creative-language, song-to-picture, storyboard, and shot work.</p>
        <button className="primaryButton" disabled={busy} onClick={initialize}>Start Treatment</button>
      </div>
    );
  }

  return (
    <div className="treatmentEditor">
      {props.needsRebase ? (
        <div className="warningBanner">The selected concept changed. Start a new Treatment version before using this one downstream.</div>
      ) : null}

      <section className="treatmentSource">
        <div>
          <p className="eyebrow">Pinned source</p>
          <h2>{version.selectedConcept.title}</h2>
          <p>{version.selectedConcept.logline}</p>
        </div>
        <div className="treatmentFacts">
          <span>Concept Set v{version.sourceConceptSetVersionNumber}</span>
          <span>Song {formatTime(version.musicMap.durationMs)}</span>
          <span>{version.musicMap.anchors.length} accepted music anchors</span>
          <span>Treatment v{version.versionNumber}</span>
        </div>
      </section>

      <section className="treatmentGeneration">
        <div>
          <h3>Generate structured treatment</h3>
          <p className="dashboardNote">Generation uses the selected concept, locked Creative Brief, and accepted music anchors. It does not alter the song.</p>
        </div>
        <textarea
          value={direction}
          disabled={disabled}
          maxLength={5000}
          placeholder="Optional additional direction for this treatment..."
          onChange={(event) => setDirection(event.target.value)}
        />
        <button className="secondaryButton" disabled={disabled || !props.providerAvailable} onClick={generate}>
          {active ? "Generating…" : draft.sections.length ? "Regenerate treatment" : "Generate treatment"}
        </button>
        {!props.providerAvailable ? <p className="dashboardNote">Configure the text-generation provider to use AI generation. Manual editing remains available.</p> : null}
        {job ? <p className="dashboardNote">{job.progressPercent}% · {job.progressMessage ?? job.status}</p> : null}
      </section>

      <section className="treatmentLongForm">
        {TOP_FIELDS.map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <textarea
              value={String(draft[key])}
              disabled={disabled}
              onChange={(event) => setTop(key, event.target.value)}
            />
          </label>
        ))}
      </section>

      <section className="treatmentSections">
        <div className="treatmentSectionHeader">
          <div>
            <p className="eyebrow">Song-to-picture treatment map</p>
            <h3>Major treatment sections</h3>
          </div>
          <button
            className="secondaryButton"
            type="button"
            disabled={disabled || draft.sections.length >= 24}
            onClick={() => {
              setDraft({ ...draft, sections: [...draft.sections, emptySection(version.musicMap.durationMs)] });
              setDirty(true);
            }}
          >Add section</button>
        </div>

        {draft.sections.map((section, index) => (
          <article className="treatmentSectionCard" key={index}>
            <div className="treatmentSectionTiming">
              <input value={section.title} disabled={disabled} placeholder="Section title" onChange={(e) => updateSection(index, { title: e.target.value })} />
              <label><span>Start ms</span><input type="number" min={0} max={version.musicMap.durationMs} value={section.startMs} disabled={disabled} onChange={(e) => updateSection(index, { startMs: Number(e.target.value) })} /></label>
              <label><span>End ms</span><input type="number" min={0} max={version.musicMap.durationMs} value={section.endMs} disabled={disabled} onChange={(e) => updateSection(index, { endMs: Number(e.target.value) })} /></label>
              <button className="textButton" disabled={disabled || draft.sections.length <= 2} onClick={() => {
                setDraft({ ...draft, sections: draft.sections.filter((_, i) => i !== index) });
                setDirty(true);
              }}>Remove</button>
            </div>
            <div className="treatmentSectionGrid">
              {([
                ["dramaticPurpose","Dramatic purpose"],
                ["picturePlan","Picture plan"],
                ["narrativeProgression","Narrative progression"],
                ["performancePlan","Performance plan"],
                ["visualProgression","Visual progression"],
                ["characterProgression","Character progression"],
                ["worldChange","World change"],
                ["majorReveal","Major reveal"],
                ["transitionIntent","Transition intent"]
              ] as const).map(([key,label]) => (
                <label key={key}><span>{label}</span><textarea value={section[key]} disabled={disabled} onChange={(e) => updateSection(index, { [key]: e.target.value })} /></label>
              ))}
              <label><span>Music anchor labels · comma separated</span><input value={section.musicAnchorLabels.join(", ")} disabled={disabled} onChange={(e) => updateSection(index, { musicAnchorLabels: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
              <label><span>Motifs · comma separated</span><input value={section.motifs.join(", ")} disabled={disabled} onChange={(e) => updateSection(index, { motifs: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
            </div>
          </article>
        ))}
      </section>

      {impact.length ? (
        <section className="impactWarning">
          <strong>Downstream work affected</strong>
          {impact.map((item) => (
            <p key={item.stepKey}>
              {item.title}: {item.locked ? "locked content now needs review" : "needs review"}
            </p>
          ))}
        </section>
      ) : null}

      {message ? <p className="formMessage">{message}</p> : null}

      <div className="treatmentActions">
        <button className="secondaryButton" disabled={disabled || !dirty} onClick={save}>Save treatment</button>
        {status === "COMPLETED" && !locked ? <button className="secondaryButton" disabled={busy} onClick={() => transition("reopen")}>Reopen</button> : null}
        {status !== "COMPLETED" && !locked ? <button className="primaryButton" disabled={disabled || dirty} onClick={() => transition("complete")}>Complete Treatment</button> : null}
        {status === "COMPLETED" && !locked ? <button className="primaryButton" disabled={busy || dirty} onClick={() => transition("lock")}>Lock Treatment</button> : null}
      </div>
    </div>
  );
}
