import {
  DependencyRelation,
  DomainVersionKind,
  MusicMapAnchorDecision,
  MusicMapAnchorKind,
  MusicMapAnchorSource,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import {
  musicAnalysisResultSchema,
  type MusicAnalysisResult
} from "@/lib/music-analysis/result";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class MusicMapError extends Error {}
export class MusicMapConflictError extends MusicMapError {}

type Tx = Prisma.TransactionClient;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseNumberArray(value: Prisma.JsonValue): number[] {
  if (!Array.isArray(value)) {
    throw new MusicMapError("Music map beat/bar grid is invalid.");
  }

  return value.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new MusicMapError("Music map beat/bar grid contains an invalid value.");
    }
    return Math.max(0, Math.round(item));
  });
}

function validateRange(startMs: number, endMs: number | null | undefined, durationMs: number) {
  if (startMs < 0 || startMs > durationMs) {
    throw new MusicMapError("Anchor start must fall within the song.");
  }
  if (endMs !== null && endMs !== undefined) {
    if (endMs < startMs) {
      throw new MusicMapError("Anchor end cannot precede its start.");
    }
    if (endMs > durationMs) {
      throw new MusicMapError("Anchor end must fall within the song.");
    }
  }
}

function analysisAnchors(result: MusicAnalysisResult) {
  const anchors: Array<{
    sourceKey: string;
    kind: MusicMapAnchorKind;
    source: MusicMapAnchorSource;
    decision: MusicMapAnchorDecision;
    label: string;
    startMs: number;
    endMs: number | null;
    sourceStartMs: number;
    sourceEndMs: number | null;
    sourceConfidence: number | null;
    position: number;
    metadata?: Prisma.InputJsonValue;
  }> = [];

  const add = (
    sourceKey: string,
    kind: MusicMapAnchorKind,
    label: string,
    startMs: number,
    endMs: number | null,
    confidence: number | null,
    metadata?: unknown
  ) => {
    anchors.push({
      sourceKey,
      kind,
      source: MusicMapAnchorSource.ANALYSIS,
      decision: MusicMapAnchorDecision.PENDING,
      label,
      startMs,
      endMs,
      sourceStartMs: startMs,
      sourceEndMs: endMs,
      sourceConfidence: confidence,
      position: anchors.length,
      metadata: metadata === undefined ? undefined : toJson(metadata)
    });
  };

  result.sections.forEach((section, index) => {
    add(
      "section:" + index,
      MusicMapAnchorKind.SECTION,
      section.label,
      section.startMs,
      section.endMs,
      null,
      { meanEnergy: section.meanEnergy }
    );
  });

  add(
    "intro:0",
    MusicMapAnchorKind.INTRO,
    "Intro candidate",
    result.introCandidate.startMs,
    result.introCandidate.endMs,
    null,
    { basis: result.introCandidate.basis }
  );
  add(
    "outro:0",
    MusicMapAnchorKind.OUTRO,
    "Outro candidate",
    result.outroCandidate.startMs,
    result.outroCandidate.endMs,
    null,
    { basis: result.outroCandidate.basis }
  );

  result.drops.forEach((drop, index) => {
    add(
      "drop:" + index,
      MusicMapAnchorKind.DROP,
      "Drop candidate " + (index + 1),
      drop.timeMs,
      null,
      drop.score,
      {
        preEnergy: drop.preEnergy,
        postEnergy: drop.postEnergy
      }
    );
  });

  result.transitionCandidates.forEach((transition, index) => {
    add(
      "transition:" + index,
      MusicMapAnchorKind.TRANSITION,
      "Transition: " + transition.reasons.join(" + "),
      transition.timeMs,
      null,
      transition.score,
      { reasons: transition.reasons }
    );
  });

  result.vocalPassages.forEach((passage, index) => {
    add(
      "vocal:" + index,
      MusicMapAnchorKind.VOCAL_PASSAGE,
      "Vocal passage " + (index + 1),
      passage.startMs,
      passage.endMs,
      null,
      { text: passage.text }
    );
  });

  result.instrumentalBreakCandidates.forEach((passage, index) => {
    add(
      "instrumental:" + index,
      MusicMapAnchorKind.INSTRUMENTAL_BREAK,
      "Instrumental break " + (index + 1),
      passage.startMs,
      passage.endMs,
      null,
      { basis: passage.basis }
    );
  });

  return anchors;
}

async function semanticSnapshot(tx: Tx, mapVersionId: string) {
  const version = await tx.musicMapVersion.findUnique({
    where: { id: mapVersionId },
    include: {
      anchors: {
        orderBy: { position: "asc" }
      }
    }
  });
  if (!version) throw new MusicMapError("Music map version not found.");

  return {
    sourceAnalysisVersionId: version.sourceAnalysisVersionId,
    tempoBpm: version.tempoBpm,
    meterNumerator: version.meterNumerator,
    meterDenominator: version.meterDenominator,
    beatOffsetMs: version.beatOffsetMs,
    barPhase: version.barPhase,
    beatGridSource: version.beatGridSource,
    beatGridMs: parseNumberArray(version.beatGridMs),
    barGridMs: parseNumberArray(version.barGridMs),
    durationMs: version.durationMs,
    notes: version.notes,
    anchors: version.anchors.map((anchor) =>
      anchor.decision === MusicMapAnchorDecision.REJECTED
        ? {
            sourceKey: anchor.sourceKey,
            kind: anchor.kind,
            source: anchor.source,
            decision: anchor.decision,
            position: anchor.position
          }
        : {
            sourceKey: anchor.sourceKey,
            kind: anchor.kind,
            source: anchor.source,
            decision: anchor.decision,
            label: anchor.label,
            startMs: anchor.startMs,
            endMs: anchor.endMs,
            sourceStartMs: anchor.sourceStartMs,
            sourceEndMs: anchor.sourceEndMs,
            sourceConfidence: anchor.sourceConfidence,
            position: anchor.position,
            metadata: anchor.metadata
          }
    )
  };
}

async function refreshFingerprint(tx: Tx, mapVersionId: string) {
  const snapshot = await semanticSnapshot(tx, mapVersionId);
  const fingerprint = fingerprintJson(
    toJson(snapshot) as unknown as Prisma.JsonValue
  );

  const version = await tx.musicMapVersion.findUniqueOrThrow({
    where: { id: mapVersionId },
    select: { nodeId: true }
  });

  await tx.domainVersionNode.update({
    where: { id: version.nodeId },
    data: { fingerprint }
  });

  return { snapshot, fingerprint, nodeId: version.nodeId };
}

async function wizardPayload(tx: Tx, mapVersionId: string) {
  const version = await tx.musicMapVersion.findUniqueOrThrow({
    where: { id: mapVersionId },
    include: {
      anchors: {
        select: { decision: true }
      }
    }
  });

  const counts = {
    accepted: 0,
    pending: 0,
    rejected: 0
  };
  for (const anchor of version.anchors) {
    if (anchor.decision === MusicMapAnchorDecision.ACCEPTED) counts.accepted += 1;
    if (anchor.decision === MusicMapAnchorDecision.PENDING) counts.pending += 1;
    if (anchor.decision === MusicMapAnchorDecision.REJECTED) counts.rejected += 1;
  }

  return toJson({
    mapVersionId: version.id,
    mapNodeId: version.nodeId,
    mapRevision: version.revision,
    sourceAnalysisVersionId: version.sourceAnalysisVersionId,
    tempoBpm: version.tempoBpm,
    meter: version.meterNumerator + "/" + version.meterDenominator,
    beatGridSource: version.beatGridSource,
    counts
  });
}

async function syncWizardDraft(
  tx: Tx,
  input: {
    projectVersionId: string;
    mapVersionId: string;
  }
) {
  const { fingerprint } = await refreshFingerprint(tx, input.mapVersionId);
  return saveManagedWizardStepInTransaction(tx, {
    projectVersionId: input.projectVersionId,
    stepKey: "music-map",
    payload: await wizardPayload(tx, input.mapVersionId),
    semanticFingerprint: fingerprint
  });
}

async function latestAnalysisForProject(tx: Tx, projectId: string) {
  const analysis = await tx.musicAnalysisVersion.findFirst({
    where: {
      musicAnalysis: { projectId }
    },
    orderBy: { versionNumber: "desc" },
    select: {
      id: true,
      nodeId: true,
      versionNumber: true,
      durationMs: true,
      result: true
    }
  });

  if (!analysis) {
    throw new MusicMapError(
      "Run Music Analysis before creating the Music Map."
    );
  }

  return {
    ...analysis,
    result: musicAnalysisResultSchema.parse(analysis.result)
  };
}

async function mutationContext(
  tx: Tx,
  input: {
    userId: string;
    projectId: string;
    projectVersionId: string;
    mapVersionId: string;
    expectedRevision: number;
  }
) {
  const version = await tx.musicMapVersion.findFirst({
    where: {
      id: input.mapVersionId,
      musicMap: {
        projectId: input.projectId,
        project: {
          ...projectEditorWhere(input.userId)
        }
      }
    },
    include: {
      musicMap: {
        select: { projectId: true }
      },
      sourceAnalysisVersion: {
        select: {
          id: true,
          result: true
        }
      }
    }
  });

  if (!version) throw new MusicMapError("Music map version not found.");
  if (version.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This music map version is locked.");
  }
  if (version.revision !== input.expectedRevision) {
    throw new MusicMapConflictError(
      "Music Map changed in another request. Reload before continuing."
    );
  }

  const progress = await tx.wizardProgress.findFirst({
    where: {
      projectVersionId: input.projectVersionId,
      projectVersion: {
        projectId: input.projectId,
        project: {
          ...projectEditorWhere(input.userId)
        }
      }
    },
    include: {
      projectVersion: true,
      steps: true
    }
  });
  if (!progress) throw new MusicMapError("Wizard progress not found.");
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This project version is locked.");
  }
  const step = progress.steps.find((item) => item.stepKey === "music-map");
  if (!step) throw new MusicMapError("Music Map wizard state is unavailable.");
  if (step.lockedAt) {
    throw new WizardLockedError("Music Map is locked for this project version.");
  }

  return { version, progress, step };
}

async function serializeMapVersion(tx: Tx, mapVersionId: string) {
  const version = await tx.musicMapVersion.findUniqueOrThrow({
    where: { id: mapVersionId },
    include: {
      anchors: {
        orderBy: [
          { startMs: "asc" },
          { position: "asc" }
        ]
      },
      sourceAnalysisVersion: {
        select: {
          id: true,
          versionNumber: true,
          result: true
        }
      }
    }
  });

  return {
    id: version.id,
    nodeId: version.nodeId,
    versionNumber: version.versionNumber,
    lifecycle: version.lifecycle,
    sourceAnalysisVersionId: version.sourceAnalysisVersionId,
    sourceAnalysisVersionNumber: version.sourceAnalysisVersion.versionNumber,
    revision: version.revision,
    tempoBpm: version.tempoBpm,
    meterNumerator: version.meterNumerator,
    meterDenominator: version.meterDenominator,
    beatOffsetMs: version.beatOffsetMs,
    barPhase: version.barPhase,
    beatGridSource: version.beatGridSource,
    beatGridMs: parseNumberArray(version.beatGridMs),
    barGridMs: parseNumberArray(version.barGridMs),
    durationMs: version.durationMs,
    notes: version.notes,
    lockedAt: version.lockedAt,
    createdAt: version.createdAt,
    anchors: version.anchors,
    analysis: musicAnalysisResultSchema.parse(
      version.sourceAnalysisVersion.result
    )
  };
}

export async function initializeMusicMap(input: {
  userId: string;
  projectId: string;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });
  if (projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This project version is locked.");
  }

  return db.$transaction(
    async (tx) => {
      const analysis = await latestAnalysisForProject(tx, input.projectId);
      const map = await tx.musicMap.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId },
        update: {}
      });

      const latest = await tx.musicMapVersion.findFirst({
        where: { musicMapId: map.id },
        orderBy: { versionNumber: "desc" },
        include: {
          anchors: {
            orderBy: { position: "asc" }
          }
        }
      });

      if (
        latest &&
        latest.lifecycle === VersionLifecycle.DRAFT &&
        latest.sourceAnalysisVersionId === analysis.id
      ) {
        await syncWizardDraft(tx, {
          projectVersionId: projectVersion.id,
          mapVersionId: latest.id
        });
        return serializeMapVersion(tx, latest.id);
      }

      const step = await tx.wizardStepState.findFirst({
        where: {
          wizardProgress: {
            projectVersionId: projectVersion.id
          },
          stepKey: "music-map"
        }
      });
      if (!step) throw new MusicMapError("Music Map wizard state is unavailable.");
      if (step.lockedAt) {
        throw new WizardLockedError("Music Map is locked for this project version.");
      }

      if (latest?.lifecycle === VersionLifecycle.DRAFT) {
        await tx.musicMapVersion.update({
          where: { id: latest.id },
          data: { lifecycle: VersionLifecycle.SUPERSEDED }
        });
      }

      const node = await tx.domainVersionNode.create({
        data: { kind: DomainVersionKind.MUSIC_MAP }
      });

      const nextVersion = (latest?.versionNumber ?? 0) + 1;
      const sameAnalysisLocked =
        latest?.lifecycle === VersionLifecycle.LOCKED &&
        latest.sourceAnalysisVersionId === analysis.id;

      const customAnchors =
        latest && !sameAnalysisLocked
          ? latest.anchors
              .filter((anchor) => anchor.source === MusicMapAnchorSource.USER)
              .map((anchor, index) => ({
                sourceKey: null,
                kind: anchor.kind,
                source: MusicMapAnchorSource.USER,
                decision: anchor.decision,
                label: anchor.label,
                startMs: anchor.startMs,
                endMs: anchor.endMs,
                sourceStartMs: null,
                sourceEndMs: null,
                sourceConfidence: null,
                position: 10000 + index,
                metadata: anchor.metadata ?? undefined
              }))
          : [];

      const seededAnchors = sameAnalysisLocked
        ? latest!.anchors.map((anchor, index) => ({
            sourceKey: anchor.sourceKey,
            kind: anchor.kind,
            source: anchor.source,
            decision: anchor.decision,
            label: anchor.label,
            startMs: anchor.startMs,
            endMs: anchor.endMs,
            sourceStartMs: anchor.sourceStartMs,
            sourceEndMs: anchor.sourceEndMs,
            sourceConfidence: anchor.sourceConfidence,
            position: index,
            metadata: anchor.metadata ?? undefined
          }))
        : [
            ...analysisAnchors(analysis.result),
            ...customAnchors
          ].map((anchor, index) => ({
            ...anchor,
            position: index
          }));

      const created = await tx.musicMapVersion.create({
        data: {
          musicMapId: map.id,
          nodeId: node.id,
          versionNumber: nextVersion,
          lifecycle: VersionLifecycle.DRAFT,
          sourceAnalysisVersionId: analysis.id,
          tempoBpm: sameAnalysisLocked
            ? latest!.tempoBpm
            : analysis.result.tempo.bpm || null,
          meterNumerator: sameAnalysisLocked
            ? latest!.meterNumerator
            : 4,
          meterDenominator: sameAnalysisLocked
            ? latest!.meterDenominator
            : 4,
          beatOffsetMs: sameAnalysisLocked
            ? latest!.beatOffsetMs
            : analysis.result.beatsMs[0] ?? 0,
          barPhase: sameAnalysisLocked
            ? latest!.barPhase
            : analysis.result.barCandidates.phase,
          beatGridSource: sameAnalysisLocked
            ? latest!.beatGridSource
            : "analysis",
          beatGridMs: sameAnalysisLocked
            ? parseNumberArray(latest!.beatGridMs)
            : analysis.result.beatsMs,
          barGridMs: sameAnalysisLocked
            ? parseNumberArray(latest!.barGridMs)
            : analysis.result.barCandidates.barsMs,
          durationMs: analysis.result.durationMs,
          notes: sameAnalysisLocked ? latest!.notes : null,
          createdByUserId: input.userId,
          anchors: {
            create: seededAnchors
          }
        }
      });

      await registerDependencyEdgeInTransaction(tx, {
        upstreamNodeId: analysis.nodeId,
        downstreamNodeId: node.id,
        relation: DependencyRelation.DERIVED_FROM,
        reason:
          "Music Map records the human interpretation of a pinned Music Analysis version."
      });

      await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        mapVersionId: created.id
      });

      return serializeMapVersion(tx, created.id);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

function uniformGrid(input: {
  bpm: number;
  offsetMs: number;
  durationMs: number;
  meterNumerator: number;
  barPhase: number;
}) {
  const beatInterval = 60000 / input.bpm;
  const beats: number[] = [];
  let index = 0;
  for (
    let position = input.offsetMs;
    position <= input.durationMs && index < 100000;
    position = input.offsetMs + ++index * beatInterval
  ) {
    const rounded = Math.round(position);
    if (rounded >= 0 && rounded <= input.durationMs) beats.push(rounded);
  }

  const normalizedPhase =
    ((input.barPhase % input.meterNumerator) + input.meterNumerator) %
    input.meterNumerator;
  const bars = beats.filter(
    (_, beatIndex) => beatIndex % input.meterNumerator === normalizedPhase
  );

  return { beats, bars, normalizedPhase };
}

export async function updateMusicMapGrid(input: {
  userId: string;
  projectId: string;
  mapVersionId: string;
  expectedRevision: number;
  mode: "manual-tempo" | "analysis";
  tempoBpm?: number;
  meterNumerator?: number;
  meterDenominator?: number;
  beatOffsetMs?: number;
  barPhase?: number;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });

      let update: Prisma.MusicMapVersionUpdateManyMutationInput;
      if (input.mode === "analysis") {
        const result = musicAnalysisResultSchema.parse(
          context.version.sourceAnalysisVersion.result
        );
        update = {
          tempoBpm: result.tempo.bpm || null,
          meterNumerator: 4,
          meterDenominator: 4,
          beatOffsetMs: result.beatsMs[0] ?? 0,
          barPhase: result.barCandidates.phase,
          beatGridSource: "analysis",
          beatGridMs: result.beatsMs,
          barGridMs: result.barCandidates.barsMs
        };
      } else {
        if (
          input.tempoBpm === undefined ||
          input.meterNumerator === undefined ||
          input.meterDenominator === undefined ||
          input.beatOffsetMs === undefined ||
          input.barPhase === undefined
        ) {
          throw new MusicMapError(
            "Manual grid correction requires BPM, meter, beat offset, and bar phase."
          );
        }
        if (input.beatOffsetMs > context.version.durationMs) {
          throw new MusicMapError("Beat offset must fall within the song.");
        }
        if (input.barPhase >= input.meterNumerator) {
          throw new MusicMapError(
            "Bar phase must be smaller than the meter numerator."
          );
        }

        const grid = uniformGrid({
          bpm: input.tempoBpm,
          offsetMs: input.beatOffsetMs,
          durationMs: context.version.durationMs,
          meterNumerator: input.meterNumerator,
          barPhase: input.barPhase
        });
        update = {
          tempoBpm: input.tempoBpm,
          meterNumerator: input.meterNumerator,
          meterDenominator: input.meterDenominator,
          beatOffsetMs: input.beatOffsetMs,
          barPhase: grid.normalizedPhase,
          beatGridSource: "manual-tempo",
          beatGridMs: grid.beats,
          barGridMs: grid.bars
        };
      }

      const changed = await tx.musicMapVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision,
          lifecycle: VersionLifecycle.DRAFT
        },
        data: {
          ...update,
          revision: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new MusicMapConflictError(
          "Music Map changed while the grid correction was being saved."
        );
      }

      await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        mapVersionId: context.version.id
      });

      return serializeMapVersion(tx, context.version.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function createMusicMapAnchor(input: {
  userId: string;
  projectId: string;
  mapVersionId: string;
  expectedRevision: number;
  kind: MusicMapAnchorKind;
  label: string;
  startMs: number;
  endMs?: number | null;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });
      validateRange(
        input.startMs,
        input.endMs,
        context.version.durationMs
      );

      const max = await tx.musicMapAnchor.aggregate({
        where: { musicMapVersionId: context.version.id },
        _max: { position: true }
      });

      await tx.musicMapAnchor.create({
        data: {
          musicMapVersionId: context.version.id,
          sourceKey: null,
          kind: input.kind,
          source: MusicMapAnchorSource.USER,
          decision: MusicMapAnchorDecision.ACCEPTED,
          label: input.label,
          startMs: input.startMs,
          endMs: input.endMs ?? null,
          position: (max._max.position ?? -1) + 1
        }
      });

      const changed = await tx.musicMapVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision
        },
        data: { revision: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new MusicMapConflictError(
          "Music Map changed while the anchor was being added."
        );
      }

      await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        mapVersionId: context.version.id
      });

      return serializeMapVersion(tx, context.version.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function updateMusicMapAnchor(input: {
  userId: string;
  projectId: string;
  mapVersionId: string;
  anchorId: string;
  expectedRevision: number;
  label?: string;
  startMs?: number;
  endMs?: number | null;
  decision?: MusicMapAnchorDecision;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });
      const anchor = await tx.musicMapAnchor.findFirst({
        where: {
          id: input.anchorId,
          musicMapVersionId: context.version.id
        }
      });
      if (!anchor) throw new MusicMapError("Music Map anchor not found.");

      const startMs = input.startMs ?? anchor.startMs;
      const endMs =
        input.endMs === undefined ? anchor.endMs : input.endMs;
      validateRange(startMs, endMs, context.version.durationMs);

      await tx.musicMapAnchor.update({
        where: { id: anchor.id },
        data: {
          label: input.label,
          startMs: input.startMs,
          endMs: input.endMs,
          decision: input.decision
        }
      });

      const changed = await tx.musicMapVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision
        },
        data: { revision: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new MusicMapConflictError(
          "Music Map changed while the anchor was being saved."
        );
      }

      await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        mapVersionId: context.version.id
      });

      return serializeMapVersion(tx, context.version.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function deleteMusicMapAnchor(input: {
  userId: string;
  projectId: string;
  mapVersionId: string;
  anchorId: string;
  expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });
      const anchor = await tx.musicMapAnchor.findFirst({
        where: {
          id: input.anchorId,
          musicMapVersionId: context.version.id
        }
      });
      if (!anchor) throw new MusicMapError("Music Map anchor not found.");
      if (anchor.source !== MusicMapAnchorSource.USER) {
        throw new MusicMapError(
          "Machine candidates are rejected rather than deleted so the decision remains auditable."
        );
      }

      await tx.musicMapAnchor.delete({ where: { id: anchor.id } });
      const changed = await tx.musicMapVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision
        },
        data: { revision: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new MusicMapConflictError(
          "Music Map changed while the anchor was being deleted."
        );
      }

      await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        mapVersionId: context.version.id
      });

      return serializeMapVersion(tx, context.version.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function decidePendingMusicMapAnchors(input: {
  userId: string;
  projectId: string;
  mapVersionId: string;
  expectedRevision: number;
  decision: "ACCEPTED" | "REJECTED";
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });

      await tx.musicMapAnchor.updateMany({
        where: {
          musicMapVersionId: context.version.id,
          decision: MusicMapAnchorDecision.PENDING
        },
        data: {
          decision:
            input.decision === "ACCEPTED"
              ? MusicMapAnchorDecision.ACCEPTED
              : MusicMapAnchorDecision.REJECTED
        }
      });

      const changed = await tx.musicMapVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision
        },
        data: { revision: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new MusicMapConflictError(
          "Music Map changed while pending candidates were being resolved."
        );
      }

      await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        mapVersionId: context.version.id
      });

      return serializeMapVersion(tx, context.version.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function completeMusicMap(input: {
  userId: string;
  projectId: string;
  mapVersionId: string;
  expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });

      const pending = await tx.musicMapAnchor.count({
        where: {
          musicMapVersionId: context.version.id,
          decision: MusicMapAnchorDecision.PENDING
        }
      });
      if (pending > 0) {
        throw new MusicMapError(
          "Resolve every pending machine candidate before completing the Music Map."
        );
      }

      const accepted = await tx.musicMapAnchor.count({
        where: {
          musicMapVersionId: context.version.id,
          decision: MusicMapAnchorDecision.ACCEPTED
        }
      });
      if (accepted === 0) {
        throw new MusicMapError(
          "The Music Map must contain at least one accepted anchor."
        );
      }

      const changed = await tx.musicMapVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision
        },
        data: { revision: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new MusicMapConflictError(
          "Music Map changed while it was being completed."
        );
      }

      const { fingerprint } = await refreshFingerprint(
        tx,
        context.version.id
      );
      await completeAutomaticWizardStepInTransaction(tx, {
        projectVersionId: projectVersion.id,
        stepKey: "music-map",
        payload: await wizardPayload(tx, context.version.id),
        semanticFingerprint: fingerprint
      });

      return serializeMapVersion(tx, context.version.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function lockMusicMap(input: {
  userId: string;
  projectId: string;
  mapVersionId: string;
  expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });

      if (context.step.status !== WizardStepStatus.COMPLETED) {
        throw new MusicMapError(
          "Complete the Music Map before locking it."
        );
      }

      const now = new Date();
      const changed = await tx.musicMapVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision,
          lifecycle: VersionLifecycle.DRAFT
        },
        data: {
          lifecycle: VersionLifecycle.LOCKED,
          revision: { increment: 1 },
          lockedAt: now
        }
      });
      if (changed.count !== 1) {
        throw new MusicMapConflictError(
          "Music Map changed while it was being locked."
        );
      }

      await tx.wizardStepState.update({
        where: { id: context.step.id },
        data: { lockedAt: now }
      });
      await tx.wizardProgress.update({
        where: { id: context.progress.id },
        data: { revision: { increment: 1 } }
      });

      await refreshFingerprint(tx, context.version.id);
      return serializeMapVersion(tx, context.version.id);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function getMusicMapState(input: {
  userId: string;
  projectId: string;
}) {
  const project = await db.project.findFirst({
    where: {
      id: input.projectId,
      archivedAt: null,
      ...projectEditorWhere(input.userId)
    },
    select: {
      id: true,
      musicAnalysis: {
        select: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: {
              id: true,
              versionNumber: true,
              result: true
            }
          }
        }
      },
      musicMap: {
        select: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 5,
            select: {
              id: true,
              nodeId: true,
              versionNumber: true,
              lifecycle: true,
              sourceAnalysisVersionId: true,
              revision: true,
              tempoBpm: true,
              meterNumerator: true,
              meterDenominator: true,
              beatOffsetMs: true,
              barPhase: true,
              beatGridSource: true,
              beatGridMs: true,
              barGridMs: true,
              durationMs: true,
              notes: true,
              lockedAt: true,
              createdAt: true,
              anchors: {
                orderBy: [
                  { startMs: "asc" },
                  { position: "asc" }
                ]
              },
              sourceAnalysisVersion: {
                select: {
                  versionNumber: true,
                  result: true
                }
              }
            }
          }
        }
      }
    }
  });
  if (!project) throw new MusicMapError("Project not found.");

  const latestAnalysisRaw = project.musicAnalysis?.versions[0] ?? null;
  const latestAnalysis = latestAnalysisRaw
    ? {
        ...latestAnalysisRaw,
        result: musicAnalysisResultSchema.parse(latestAnalysisRaw.result)
      }
    : null;

  const versions =
    project.musicMap?.versions.map((version) => {
      const { sourceAnalysisVersion, anchors, ...mapVersion } = version;
      return {
        ...mapVersion,
        sourceAnalysisVersionNumber: sourceAnalysisVersion.versionNumber,
        beatGridMs: parseNumberArray(version.beatGridMs),
        barGridMs: parseNumberArray(version.barGridMs),
        anchors: anchors.map((anchor) => ({
          id: anchor.id,
          musicMapVersionId: anchor.musicMapVersionId,
          sourceKey: anchor.sourceKey,
          kind: anchor.kind,
          source: anchor.source,
          decision: anchor.decision,
          label: anchor.label,
          startMs: anchor.startMs,
          endMs: anchor.endMs,
          sourceStartMs: anchor.sourceStartMs,
          sourceEndMs: anchor.sourceEndMs,
          sourceConfidence: anchor.sourceConfidence,
          position: anchor.position,
          metadata: anchor.metadata
        })),
        analysis: musicAnalysisResultSchema.parse(
          sourceAnalysisVersion.result
        )
      };
    }) ?? [];

  return {
    latestAnalysis,
    latest: versions[0] ?? null,
    versions,
    needsRebase:
      Boolean(latestAnalysis && versions[0]) &&
      latestAnalysis!.id !== versions[0]!.sourceAnalysisVersionId
  };
}
