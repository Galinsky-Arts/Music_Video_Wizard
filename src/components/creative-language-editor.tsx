"use client";

import { useEffect, useState } from "react";
import { useLatest } from "./use-latest";
import { useRouter } from "next/navigation";

type CharacterRule = {
  name: string;
  identity: string;
  appearance: string;
  performance: string;
  continuity: string;
};

type LocationRule = {
  name: string;
  visualRules: string;
  evolution: string;
  continuity: string;
};

type WardrobeRule = {
  name: string;
  appliesTo: string;
  description: string;
  continuity: string;
};

type MotifRule = {
  name: string;
  visualTreatment: string;
  meaning: string;
  continuity: string;
};

type Document = {
  title: string;
  governingIdea: string;
  visualAesthetic: string;
  colorSystem: string;
  materialsAndTexture: string;
  lightingGrammar: string;
  compositionGrammar: string;
  cinematographyGrammar: string;
  cameraMotionGrammar: string;
  subjectMotionGrammar: string;
  performanceGrammar: string;
  editingGrammar: string;
  transitionGrammar: string;
  pacingCurve: string;
  worldRules: string;
  continuityRules: string;
  typographyAndGraphics: string;
  characters: CharacterRule[];
  locations: LocationRule[];
  wardrobe: WardrobeRule[];
  motifsAndProps: MotifRule[];
  positiveGenerationLanguage: string[];
  negativeGenerationLanguage: string[];
  hardExclusions: string[];
  notes: string;
};

type VersionView = {
  id: string;
  versionNumber: number;
  lifecycle: string;
  revision: number;
  sourceTreatmentVersionId: string;
  sourceTreatmentVersionNumber: number;
  document: Document;
  generationJobId: string | null;
};

type JobView = {
  id: string;
  status: string;
  progressPercent: number;
  progressMessage: string | null;
  errorMessage: string | null;
} | null;

type ImpactWarning = {
  stepKey: string;
  title: string;
  locked: boolean;
  status?: string;
};

const LONG_FIELDS: Array<[keyof Omit<
  Document,
  | "characters"
  | "locations"
  | "wardrobe"
  | "motifsAndProps"
  | "positiveGenerationLanguage"
  | "negativeGenerationLanguage"
  | "hardExclusions"
>, string]> = [
  ["title", "Creative Language title"],
  ["governingIdea", "Governing idea"],
  ["visualAesthetic", "Visual aesthetic"],
  ["colorSystem", "Color system"],
  ["materialsAndTexture", "Materials & texture"],
  ["lightingGrammar", "Lighting grammar"],
  ["compositionGrammar", "Composition grammar"],
  ["cinematographyGrammar", "Cinematography grammar"],
  ["cameraMotionGrammar", "Camera-motion grammar"],
  ["subjectMotionGrammar", "Subject-motion grammar"],
  ["performanceGrammar", "Performance grammar"],
  ["editingGrammar", "Editing grammar"],
  ["transitionGrammar", "Transition grammar"],
  ["pacingCurve", "Pacing curve"],
  ["worldRules", "World rules"],
  ["continuityRules", "Continuity rules"],
  ["typographyAndGraphics", "Typography & graphics"],
  ["notes", "Additional notes"]
];

function emptyCharacter(): CharacterRule {
  return {
    name: "",
    identity: "",
    appearance: "",
    performance: "",
    continuity: ""
  };
}

function emptyLocation(): LocationRule {
  return {
    name: "",
    visualRules: "",
    evolution: "",
    continuity: ""
  };
}

function emptyWardrobe(): WardrobeRule {
  return {
    name: "",
    appliesTo: "",
    description: "",
    continuity: ""
  };
}

function emptyMotif(): MotifRule {
  return {
    name: "",
    visualTreatment: "",
    meaning: "",
    continuity: ""
  };
}

export function CreativeLanguageEditor(props: {
  projectId: string;
  sourceReady: boolean;
  needsRebase: boolean;
  initialVersion: VersionView | null;
  recentJob: JobView;
  providerAvailable: boolean;
  wizardStatus: string;
  wizardLocked: boolean;
  downstreamImpact: ImpactWarning[];
}) {
  const router = useRouter();
  const [version, setVersion] = useState<VersionView | null>(
    props.initialVersion
  );
  const [document, setDocument] = useState<Document | null>(
    props.initialVersion?.document ?? null
  );
  const [job, setJob] = useState<JobView>(props.recentJob);
  const [status, setStatus] = useState(props.wizardStatus);
  const [locked, setLocked] = useState(props.wizardLocked);
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [impact, setImpact] = useState(props.downstreamImpact);

  const active =
    job?.status === "QUEUED" || job?.status === "RUNNING";
  const disabled =
    busy ||
    active ||
    locked ||
    version?.lifecycle === "LOCKED";

  async function refreshState() {
    const response = await fetch(
      `/api/projects/${props.projectId}/creative-language`,
      { cache: "no-store" }
    );
    if (!response.ok) return;
    const state = (await response.json()) as {
      latest: VersionView | null;
      recentJob: JobView;
    };
    if (state.latest) {
      setVersion(state.latest);
      setDocument(state.latest.document);
      setDirty(false);
    }
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
        ["SUCCEEDED", "FAILED", "CANCELLED"].includes(next.status)
      ) {
        window.clearInterval(timer);
        await refreshStateRef.current();
        setMessage(
          next.status === "SUCCEEDED"
            ? "Creative Language generated. Review and edit it before completion."
            : next.errorMessage ??
                "Creative Language generation did not complete."
        );
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
        `/api/projects/${props.projectId}/creative-language`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "initialize" })
        }
      );
      const result = (await response.json()) as VersionView & {
        error?: string;
      };
      if (!response.ok || !result.id) {
        setMessage(
          result.error ?? "Creative Language could not be initialized."
        );
        return;
      }
      setVersion(result);
      setDocument(result.document);
      setStatus("IN_PROGRESS");
      setDirty(false);
      setMessage(
        "Creative Language v" +
          result.versionNumber +
          " created from Treatment v" +
          result.sourceTreatmentVersionNumber +
          "."
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!version || !document) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/creative-language`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "save",
            creativeLanguageVersionId: version.id,
            expectedRevision: version.revision,
            document
          })
        }
      );
      const result = (await response.json()) as {
        version?: VersionView;
        impactWarnings?: ImpactWarning[];
        error?: string;
      };
      if (!response.ok || !result.version) {
        setMessage(
          result.error ?? "Creative Language could not be saved."
        );
        return;
      }
      setVersion(result.version);
      setDocument(result.version.document);
      setDirty(false);
      setStatus("IN_PROGRESS");
      if (result.impactWarnings?.length) {
        setImpact(result.impactWarnings);
      }
      setMessage("Creative Language saved.");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!version) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/creative-language/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            creativeLanguageVersionId: version.id,
            expectedRevision: version.revision,
            direction
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
          result.error ??
            "Creative Language generation could not be queued."
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
    } finally {
      setBusy(false);
    }
  }

  async function transition(
    action: "complete" | "reopen" | "lock"
  ) {
    if (!version) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/creative-language`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            creativeLanguageVersionId: version.id,
            expectedRevision: version.revision
          })
        }
      );
      const result = (await response.json()) as {
        version?: VersionView;
        impactWarnings?: ImpactWarning[];
        error?: string;
      };
      if (!response.ok || !result.version) {
        setMessage(
          result.error ?? "Creative Language transition failed."
        );
        return;
      }
      setVersion(result.version);
      setDocument(result.version.document);
      if (result.impactWarnings?.length) {
        setImpact(result.impactWarnings);
      }
      if (action === "complete") setStatus("COMPLETED");
      if (action === "reopen") setStatus("IN_PROGRESS");
      if (action === "lock") setLocked(true);
      setMessage(
        action === "lock"
          ? "Creative Language locked."
          : action === "complete"
            ? "Creative Language completed."
            : "Creative Language reopened."
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function setText(
    key: keyof Omit<
      Document,
      | "characters"
      | "locations"
      | "wardrobe"
      | "motifsAndProps"
      | "positiveGenerationLanguage"
      | "negativeGenerationLanguage"
      | "hardExclusions"
    >,
    value: string
  ) {
    if (!document) return;
    setDocument({ ...document, [key]: value });
    setDirty(true);
  }

  function setList(
    key:
      | "positiveGenerationLanguage"
      | "negativeGenerationLanguage"
      | "hardExclusions",
    value: string
  ) {
    if (!document) return;
    setDocument({
      ...document,
      [key]: value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    });
    setDirty(true);
  }

  if (!props.sourceReady) {
    return (
      <div className="creativeLanguageEmpty">
        <h2>Creative Language is waiting for locked Treatment</h2>
        <p>
          Complete and lock the Treatment before defining reusable
          visual and editorial rules.
        </p>
      </div>
    );
  }

  if (!version || !document) {
    return (
      <div className="creativeLanguageEmpty">
        <p className="eyebrow">PR 16 · Creative Language</p>
        <h2>Define the rules that keep the whole video coherent</h2>
        <p>
          This stage converts the locked Treatment into reusable
          visual, continuity, camera, motion, performance, and
          editing grammar for later planning and generation.
        </p>
        <button
          className="primaryButton"
          disabled={busy}
          onClick={initialize}
        >
          Start Creative Language
        </button>
      </div>
    );
  }

  return (
    <div className="creativeLanguageEditor">
      {props.needsRebase ? (
        <div className="warningBanner">
          A newer locked Treatment exists. Start a new Creative
          Language version before using this one downstream.
        </div>
      ) : null}

      <section className="creativeLanguageSource">
        <div>
          <p className="eyebrow">Pinned source</p>
          <h2>Creative Language v{version.versionNumber}</h2>
          <p>
            Built from locked Treatment v
            {version.sourceTreatmentVersionNumber}.
          </p>
        </div>
        <div className="creativeLanguageFacts">
          <span>{document.characters.length} characters</span>
          <span>{document.locations.length} locations</span>
          <span>{document.motifsAndProps.length} motifs / props</span>
          <span>{document.hardExclusions.length} hard exclusions</span>
        </div>
      </section>

      <section className="creativeLanguageGenerate">
        <h3>Generate project-wide creative grammar</h3>
        <p className="dashboardNote">
          Generation expands only the locked Treatment into reusable
          rules. It does not create storyboard shots.
        </p>
        <textarea
          value={direction}
          disabled={disabled}
          maxLength={5000}
          placeholder="Optional additional direction..."
          onChange={(event) => setDirection(event.target.value)}
        />
        <button
          className="secondaryButton"
          disabled={disabled || !props.providerAvailable}
          onClick={generate}
        >
          {active
            ? "Generating…"
            : document.visualAesthetic
              ? "Regenerate Creative Language"
              : "Generate Creative Language"}
        </button>
        {!props.providerAvailable ? (
          <p className="dashboardNote">
            Configure the text-generation provider to use AI
            generation. Manual editing remains available.
          </p>
        ) : null}
        {job ? (
          <p className="dashboardNote">
            {job.progressPercent}% ·{" "}
            {job.progressMessage ?? job.status}
          </p>
        ) : null}
      </section>

      <section className="creativeLanguageRules">
        {LONG_FIELDS.map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <textarea
              value={String(document[key])}
              disabled={disabled}
              onChange={(event) =>
                setText(key, event.target.value)
              }
            />
          </label>
        ))}
      </section>

      <section className="creativeLanguageLists">
        <label>
          <span>Positive generation language · one rule per line</span>
          <textarea
            value={document.positiveGenerationLanguage.join("\n")}
            disabled={disabled}
            onChange={(event) =>
              setList(
                "positiveGenerationLanguage",
                event.target.value
              )
            }
          />
        </label>
        <label>
          <span>Negative generation language · one rule per line</span>
          <textarea
            value={document.negativeGenerationLanguage.join("\n")}
            disabled={disabled}
            onChange={(event) =>
              setList(
                "negativeGenerationLanguage",
                event.target.value
              )
            }
          />
        </label>
        <label>
          <span>Hard exclusions · one rule per line</span>
          <textarea
            value={document.hardExclusions.join("\n")}
            disabled={disabled}
            onChange={(event) =>
              setList("hardExclusions", event.target.value)
            }
          />
        </label>
      </section>

      <RuleCollection
        title="Characters"
        disabled={disabled}
        items={document.characters}
        add={emptyCharacter}
        fields={[
          ["name", "Name"],
          ["identity", "Identity / dramatic role"],
          ["appearance", "Appearance rules"],
          ["performance", "Performance rules"],
          ["continuity", "Continuity rules"]
        ]}
        onChange={(items) => {
          setDocument({ ...document, characters: items });
          setDirty(true);
        }}
      />
      <RuleCollection
        title="Locations / worlds"
        disabled={disabled}
        items={document.locations}
        add={emptyLocation}
        fields={[
          ["name", "Name"],
          ["visualRules", "Visual rules"],
          ["evolution", "Evolution"],
          ["continuity", "Continuity"]
        ]}
        onChange={(items) => {
          setDocument({ ...document, locations: items });
          setDirty(true);
        }}
      />
      <RuleCollection
        title="Wardrobe"
        disabled={disabled}
        items={document.wardrobe}
        add={emptyWardrobe}
        fields={[
          ["name", "Name"],
          ["appliesTo", "Applies to"],
          ["description", "Description"],
          ["continuity", "Continuity"]
        ]}
        onChange={(items) => {
          setDocument({ ...document, wardrobe: items });
          setDirty(true);
        }}
      />
      <RuleCollection
        title="Motifs & props"
        disabled={disabled}
        items={document.motifsAndProps}
        add={emptyMotif}
        fields={[
          ["name", "Name"],
          ["visualTreatment", "Visual treatment"],
          ["meaning", "Meaning / function"],
          ["continuity", "Continuity"]
        ]}
        onChange={(items) => {
          setDocument({ ...document, motifsAndProps: items });
          setDirty(true);
        }}
      />

      {impact.length ? (
        <section className="impactWarning">
          <strong>Downstream work affected</strong>
          {impact.map((item) => (
            <p key={item.stepKey}>
              {item.title}:{" "}
              {item.locked
                ? "locked content now needs review"
                : "needs review"}
            </p>
          ))}
        </section>
      ) : null}

      {message ? <p className="formMessage">{message}</p> : null}

      <div className="creativeLanguageActions">
        <button
          className="secondaryButton"
          disabled={disabled || !dirty}
          onClick={save}
        >
          Save Creative Language
        </button>
        {status === "COMPLETED" && !locked ? (
          <button
            className="secondaryButton"
            disabled={busy}
            onClick={() => transition("reopen")}
          >
            Reopen
          </button>
        ) : null}
        {status !== "COMPLETED" && !locked ? (
          <button
            className="primaryButton"
            disabled={disabled || dirty}
            onClick={() => transition("complete")}
          >
            Complete Creative Language
          </button>
        ) : null}
        {status === "COMPLETED" && !locked ? (
          <button
            className="primaryButton"
            disabled={busy || dirty}
            onClick={() => transition("lock")}
          >
            Lock Creative Language
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RuleCollection<T extends Record<string, string>>(props: {
  title: string;
  disabled: boolean;
  items: T[];
  add: () => T;
  fields: Array<[keyof T, string]>;
  onChange: (items: T[]) => void;
}) {
  return (
    <section className="creativeLanguageCollection">
      <div className="creativeLanguageCollectionHeader">
        <h3>{props.title}</h3>
        <button
          type="button"
          className="secondaryButton"
          disabled={props.disabled}
          onClick={() =>
            props.onChange([...props.items, props.add()])
          }
        >
          Add
        </button>
      </div>
      {props.items.map((item, index) => (
        <article
          className="creativeLanguageCollectionCard"
          key={index}
        >
          {props.fields.map(([key, label]) => (
            <label key={String(key)}>
              <span>{label}</span>
              <textarea
                value={item[key]}
                disabled={props.disabled}
                onChange={(event) => {
                  const items = props.items.map(
                    (candidate, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...candidate,
                            [key]: event.target.value
                          }
                        : candidate
                  );
                  props.onChange(items);
                }}
              />
            </label>
          ))}
          <button
            type="button"
            className="textButton"
            disabled={props.disabled}
            onClick={() =>
              props.onChange(
                props.items.filter(
                  (_, itemIndex) => itemIndex !== index
                )
              )
            }
          >
            Remove
          </button>
        </article>
      ))}
    </section>
  );
}
