import { randomUUID } from "node:crypto";
import {
  AssetStatus,
  DependencyRelation,
  DomainVersionKind,
  GenerationKind,
  GenerationStatus,
  Prisma,
  VersionLifecycle
} from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { getEnvironment } from "@/lib/env";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  prepareAutomaticWizardStepInTransaction,
  WizardError,
  WizardLockedError
} from "@/lib/wizard/service";
import {
  musicAnalysisResultSchema,
  type MusicAnalysisResult
} from "./result";
import { projectEditorWhere } from "@/lib/collaboration/access";

export const MUSIC_ANALYSIS_PROVIDER_KEY = "local-librosa";
export const MUSIC_ANALYSIS_ENGINE_VERSION = "1.0.0";

export class MusicAnalysisError extends Error {}

export const queuedMusicAnalysisRequestSchema = z.object({
  projectId: z.string().uuid(),
  projectVersionId: z.string().uuid(),
  audioAssetVersionId: z.string().uuid(),
  includeLyrics: z.boolean(),
  transcriptionProvider: z.enum(["none", "openai"]),
  transcriptionModel: z.string().nullable()
});

export type QueuedMusicAnalysisRequest = z.infer<
  typeof queuedMusicAnalysisRequestSchema
>;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function queueMusicAnalysis(input: {
  userId: string;
  projectId: string;
  includeLyrics: boolean;
}) {
  const env = getEnvironment();
  const version = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  if (version.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError(
      "This project version is locked and cannot be analyzed again."
    );
  }

  const step = version.wizardProgress!.steps.find(
    (candidate) => candidate.stepKey === "music-analysis"
  );
  if (!step) {
    throw new WizardError("Music analysis wizard state is unavailable.");
  }
  if (step.lockedAt) {
    throw new WizardLockedError(
      "Music analysis is locked for this project version."
    );
  }

  const audioAssetVersionId = version.audioMasterAssetVersionId;
  if (!audioAssetVersionId) {
    throw new MusicAnalysisError("Project has no master audio.");
  }

  const audio = await db.assetVersion.findFirst({
    where: {
      id: audioAssetVersionId,
      status: AssetStatus.READY,
      asset: {
        projectId: input.projectId,
        workspaceId: version.project.workspaceId
      }
    },
    select: {
      id: true,
      nodeId: true
    }
  });
  if (!audio) {
    throw new MusicAnalysisError("Master audio is not ready for analysis.");
  }

  if (
    input.includeLyrics &&
    env.AUDIO_TRANSCRIPTION_PROVIDER === "none"
  ) {
    throw new MusicAnalysisError(
      "Lyric transcription is not configured on this deployment."
    );
  }

  const active = await db.generationJob.findFirst({
    where: {
      projectId: input.projectId,
      kind: GenerationKind.ANALYSIS,
      providerKey: MUSIC_ANALYSIS_PROVIDER_KEY,
      status: {
        in: [GenerationStatus.QUEUED, GenerationStatus.RUNNING]
      }
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true }
  });
  if (active) {
    return {
      jobId: active.id,
      status: active.status,
      reused: true
    };
  }

  const request: QueuedMusicAnalysisRequest = {
    projectId: input.projectId,
    projectVersionId: version.id,
    audioAssetVersionId,
    includeLyrics: input.includeLyrics,
    transcriptionProvider: input.includeLyrics
      ? env.AUDIO_TRANSCRIPTION_PROVIDER
      : "none",
    transcriptionModel:
      input.includeLyrics &&
      env.AUDIO_TRANSCRIPTION_PROVIDER !== "none"
        ? env.AUDIO_TRANSCRIPTION_MODEL
        : null
  };

  const jobId = randomUUID();
  const job = await enqueueGenerationJob({
    jobId,
    workspaceId: version.project.workspaceId,
    projectId: input.projectId,
    kind: GenerationKind.ANALYSIS,
    providerKey: MUSIC_ANALYSIS_PROVIDER_KEY,
    modelKey: "librosa-" + MUSIC_ANALYSIS_ENGINE_VERSION,
    requestSnapshot: toJson(request),
    requestedByUserId: input.userId,
    inputs: [
      {
        nodeId: audio.nodeId,
        role: "master-audio",
        position: 0
      }
    ],
    prepare: (tx) =>
      prepareAutomaticWizardStepInTransaction(tx, {
        projectVersionId: version.id,
        stepKey: "music-analysis",
        payload: toJson({
          jobId,
          status: "QUEUED",
          includeLyrics: input.includeLyrics,
          requestedAt: new Date().toISOString()
        })
      })
  });

  return {
    jobId: job.id,
    status: job.status,
    reused: false
  };
}

export async function persistMusicAnalysisResult(input: {
  generationJobId: string;
  request: QueuedMusicAnalysisRequest;
  result: MusicAnalysisResult;
  requestedByUserId?: string | null;
}) {
  const result = musicAnalysisResultSchema.parse(input.result);
  const semanticFingerprint = fingerprintJson(
    result as unknown as Prisma.JsonValue
  );

  return db.$transaction(
    async (tx) => {
      const existing = await tx.musicAnalysisVersion.findUnique({
        where: { generationJobId: input.generationJobId },
        select: {
          id: true,
          nodeId: true,
          versionNumber: true
        }
      });
      if (existing) {
        return {
          analysisVersionId: existing.id,
          analysisNodeId: existing.nodeId,
          versionNumber: existing.versionNumber,
          reused: true
        };
      }

      const projectVersion = await tx.projectVersion.findFirst({
        where: {
          id: input.request.projectVersionId,
          projectId: input.request.projectId,
          audioMasterAssetVersionId:
            input.request.audioAssetVersionId
        },
        select: {
          id: true,
          projectId: true,
          project: {
            select: { workspaceId: true }
          }
        }
      });
      if (!projectVersion) {
        throw new MusicAnalysisError(
          "Music analysis request no longer matches its project version."
        );
      }

      const audio = await tx.assetVersion.findFirst({
        where: {
          id: input.request.audioAssetVersionId,
          status: AssetStatus.READY,
          asset: {
            projectId: input.request.projectId,
            workspaceId: projectVersion.project.workspaceId
          }
        },
        select: {
          id: true,
          nodeId: true
        }
      });
      if (!audio) {
        throw new MusicAnalysisError(
          "Master audio is unavailable while persisting analysis."
        );
      }

      const analysis = await tx.musicAnalysis.upsert({
        where: { projectId: input.request.projectId },
        create: { projectId: input.request.projectId },
        update: {}
      });

      const latest = await tx.musicAnalysisVersion.findFirst({
        where: { musicAnalysisId: analysis.id },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true }
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;

      const node = await tx.domainVersionNode.create({
        data: {
          kind: DomainVersionKind.MUSIC_ANALYSIS,
          fingerprint: semanticFingerprint
        }
      });

      const created = await tx.musicAnalysisVersion.create({
        data: {
          musicAnalysisId: analysis.id,
          nodeId: node.id,
          versionNumber,
          lifecycle: VersionLifecycle.LOCKED,
          audioAssetVersionId: audio.id,
          generationJobId: input.generationJobId,
          engineKey: result.analyzer.engine,
          engineVersion: result.analyzer.version,
          transcriptionProvider: result.transcript?.provider ?? null,
          transcriptionModel: result.transcript?.model ?? null,
          durationMs: result.durationMs,
          result: toJson(result),
          createdByUserId: input.requestedByUserId ?? null,
          lockedAt: new Date()
        }
      });

      await registerDependencyEdgeInTransaction(tx, {
        upstreamNodeId: audio.nodeId,
        downstreamNodeId: node.id,
        relation: DependencyRelation.DERIVED_FROM,
        reason:
          "Music analysis is deterministically derived from the immutable master audio."
      });

      await tx.generationOutput.create({
        data: {
          jobId: input.generationJobId,
          nodeId: node.id,
          role: "music-analysis",
          position: 0
        }
      });

      await tx.assetVersion.update({
        where: { id: audio.id },
        data: { durationMs: result.durationMs }
      });

      const summaryPayload = toJson({
        jobId: input.generationJobId,
        status: "COMPLETED",
        analysisVersionId: created.id,
        analysisNodeId: node.id,
        durationMs: result.durationMs,
        bpm: result.tempo.bpm,
        beatCount: result.tempo.beatCount,
        sectionCount: result.sections.length,
        dropCount: result.drops.length,
        transcriptAvailable: Boolean(result.transcript?.text),
        timestampedVocalPassages: result.vocalPassages.length,
        completedAt: new Date().toISOString()
      });

      const wizard = await completeAutomaticWizardStepInTransaction(
        tx,
        {
          projectVersionId: projectVersion.id,
          stepKey: "music-analysis",
          payload: summaryPayload,
          semanticFingerprint
        }
      );

      return {
        analysisVersionId: created.id,
        analysisNodeId: node.id,
        versionNumber,
        reused: false,
        wizardImpact: wizard
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function getMusicAnalysisState(input: {
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
      workspaceId: true,
      musicAnalysis: {
        select: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 5,
            select: {
              id: true,
              nodeId: true,
              versionNumber: true,
              engineKey: true,
              engineVersion: true,
              transcriptionProvider: true,
              transcriptionModel: true,
              durationMs: true,
              result: true,
              createdAt: true
            }
          }
        }
      }
    }
  });
  if (!project) throw new MusicAnalysisError("Project not found.");

  const recentJob = await db.generationJob.findFirst({
    where: {
      projectId: input.projectId,
      kind: GenerationKind.ANALYSIS,
      providerKey: MUSIC_ANALYSIS_PROVIDER_KEY
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      progressPercent: true,
      progressMessage: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true
    }
  });

  const versions =
    project.musicAnalysis?.versions.map((version) => ({
      ...version,
      result: musicAnalysisResultSchema.parse(version.result)
    })) ?? [];

  return {
    versions,
    latest: versions[0] ?? null,
    recentJob,
    transcriptionAvailable:
      getEnvironment().AUDIO_TRANSCRIPTION_PROVIDER !== "none"
  };
}
