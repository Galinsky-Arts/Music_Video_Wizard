import {
  DependencyRelation,
  DomainVersionKind,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import {
  creativeBriefCompletionIssues,
  creativeBriefDraftSchema,
  EMPTY_CREATIVE_BRIEF,
  type CreativeBriefDraft
} from "./input";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class CreativeBriefError extends Error {}
export class CreativeBriefConflictError extends CreativeBriefError {}

type Tx = Prisma.TransactionClient;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseBrief(value: Prisma.JsonValue): CreativeBriefDraft {
  return creativeBriefDraftSchema.parse(value);
}

async function latestMusicMap(tx: Tx, projectId: string) {
  return tx.musicMapVersion.findFirst({
    where: {
      musicMap: { projectId }
    },
    orderBy: { versionNumber: "desc" },
    include: {
      anchors: {
        where: { decision: "ACCEPTED" },
        orderBy: [
          { startMs: "asc" },
          { position: "asc" }
        ],
        select: {
          id: true,
          kind: true,
          label: true,
          startMs: true,
          endMs: true,
          source: true
        }
      }
    }
  });
}

function semanticFingerprint(input: {
  sourceMusicMapVersionId: string;
  brief: CreativeBriefDraft;
}) {
  return fingerprintJson(
    toJson({
      sourceMusicMapVersionId: input.sourceMusicMapVersionId,
      brief: input.brief
    }) as unknown as Prisma.JsonValue
  );
}

async function wizardPayload(tx: Tx, briefVersionId: string) {
  const version = await tx.creativeBriefVersion.findUniqueOrThrow({
    where: { id: briefVersionId },
    include: {
      sourceMusicMapVersion: {
        select: { versionNumber: true }
      }
    }
  });
  const brief = parseBrief(version.brief);

  return toJson({
    briefVersionId: version.id,
    briefNodeId: version.nodeId,
    briefRevision: version.revision,
    sourceMusicMapVersionId: version.sourceMusicMapVersionId,
    sourceMusicMapVersionNumber:
      version.sourceMusicMapVersion.versionNumber,
    objectiveDefined: Boolean(brief.objective.trim()),
    audienceDefined: Boolean(brief.audience.trim()),
    desiredFeelingsCount: brief.desiredFeelings.length,
    toneCount: brief.tone.length
  });
}

async function refreshFingerprint(tx: Tx, briefVersionId: string) {
  const version = await tx.creativeBriefVersion.findUniqueOrThrow({
    where: { id: briefVersionId },
    select: {
      nodeId: true,
      sourceMusicMapVersionId: true,
      brief: true
    }
  });
  const brief = parseBrief(version.brief);
  const fingerprint = semanticFingerprint({
    sourceMusicMapVersionId: version.sourceMusicMapVersionId,
    brief
  });

  await tx.domainVersionNode.update({
    where: { id: version.nodeId },
    data: { fingerprint }
  });

  return {
    fingerprint,
    nodeId: version.nodeId,
    brief
  };
}

async function syncWizardDraft(
  tx: Tx,
  input: {
    projectVersionId: string;
    briefVersionId: string;
  }
) {
  const refreshed = await refreshFingerprint(tx, input.briefVersionId);
  const wizard = await saveManagedWizardStepInTransaction(tx, {
    projectVersionId: input.projectVersionId,
    stepKey: "creative-brief",
    payload: await wizardPayload(tx, input.briefVersionId),
    semanticFingerprint: refreshed.fingerprint
  });

  return {
    ...refreshed,
    wizard
  };
}

async function serializeBriefVersion(tx: Tx, briefVersionId: string) {
  const version = await tx.creativeBriefVersion.findUniqueOrThrow({
    where: { id: briefVersionId },
    include: {
      sourceMusicMapVersion: {
        include: {
          anchors: {
            where: { decision: "ACCEPTED" },
            orderBy: [
              { startMs: "asc" },
              { position: "asc" }
            ],
            select: {
              id: true,
              kind: true,
              label: true,
              startMs: true,
              endMs: true,
              source: true
            }
          }
        }
      }
    }
  });

  return {
    id: version.id,
    nodeId: version.nodeId,
    versionNumber: version.versionNumber,
    lifecycle: version.lifecycle,
    sourceMusicMapVersionId: version.sourceMusicMapVersionId,
    sourceMusicMapVersionNumber:
      version.sourceMusicMapVersion.versionNumber,
    revision: version.revision,
    brief: parseBrief(version.brief),
    createdAt: version.createdAt,
    lockedAt: version.lockedAt,
    sourceMusicMap: {
      id: version.sourceMusicMapVersion.id,
      versionNumber: version.sourceMusicMapVersion.versionNumber,
      lifecycle: version.sourceMusicMapVersion.lifecycle,
      tempoBpm: version.sourceMusicMapVersion.tempoBpm,
      meterNumerator: version.sourceMusicMapVersion.meterNumerator,
      meterDenominator: version.sourceMusicMapVersion.meterDenominator,
      durationMs: version.sourceMusicMapVersion.durationMs,
      acceptedAnchors: version.sourceMusicMapVersion.anchors
    }
  };
}

async function mutationContext(
  tx: Tx,
  input: {
    userId: string;
    projectId: string;
    projectVersionId: string;
    briefVersionId: string;
    expectedRevision: number;
  }
) {
  const version = await tx.creativeBriefVersion.findFirst({
    where: {
      id: input.briefVersionId,
      creativeBrief: {
        projectId: input.projectId,
        project: {
          ...projectEditorWhere(input.userId)
        }
      }
    }
  });
  if (!version) {
    throw new CreativeBriefError("Creative Brief version not found.");
  }
  if (version.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This Creative Brief version is locked.");
  }
  if (version.revision !== input.expectedRevision) {
    throw new CreativeBriefConflictError(
      "Creative Brief changed in another request. Reload before continuing."
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
  if (!progress) {
    throw new CreativeBriefError("Wizard progress not found.");
  }
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This project version is locked.");
  }
  const step = progress.steps.find(
    (candidate) => candidate.stepKey === "creative-brief"
  );
  if (!step) {
    throw new CreativeBriefError(
      "Creative Brief wizard state is unavailable."
    );
  }
  if (step.lockedAt) {
    throw new WizardLockedError(
      "Creative Brief is locked for this project version."
    );
  }

  return { version, progress, step };
}

export async function initializeCreativeBrief(input: {
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
      const sourceMap = await latestMusicMap(tx, input.projectId);
      if (!sourceMap) {
        throw new CreativeBriefError(
          "Create and lock the Music Map before starting the Creative Brief."
        );
      }
      if (sourceMap.lifecycle !== VersionLifecycle.LOCKED) {
        throw new CreativeBriefError(
          "Lock the current Music Map before starting the Creative Brief."
        );
      }

      const step = await tx.wizardStepState.findFirst({
        where: {
          wizardProgress: {
            projectVersionId: projectVersion.id
          },
          stepKey: "creative-brief"
        }
      });
      if (!step) {
        throw new CreativeBriefError(
          "Creative Brief wizard state is unavailable."
        );
      }
      if (step.lockedAt) {
        throw new WizardLockedError(
          "Creative Brief is locked for this project version."
        );
      }

      const logical = await tx.creativeBrief.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId },
        update: {}
      });

      const latest = await tx.creativeBriefVersion.findFirst({
        where: { creativeBriefId: logical.id },
        orderBy: { versionNumber: "desc" }
      });

      if (
        latest &&
        latest.lifecycle === VersionLifecycle.DRAFT &&
        latest.sourceMusicMapVersionId === sourceMap.id
      ) {
        await syncWizardDraft(tx, {
          projectVersionId: projectVersion.id,
          briefVersionId: latest.id
        });
        return serializeBriefVersion(tx, latest.id);
      }

      if (latest?.lifecycle === VersionLifecycle.DRAFT) {
        await tx.creativeBriefVersion.update({
          where: { id: latest.id },
          data: { lifecycle: VersionLifecycle.SUPERSEDED }
        });
      }

      const seedBrief = latest
        ? parseBrief(latest.brief)
        : EMPTY_CREATIVE_BRIEF;

      const node = await tx.domainVersionNode.create({
        data: {
          kind: DomainVersionKind.CREATIVE_BRIEF
        }
      });

      const created = await tx.creativeBriefVersion.create({
        data: {
          creativeBriefId: logical.id,
          nodeId: node.id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          sourceMusicMapVersionId: sourceMap.id,
          brief: toJson(seedBrief),
          createdByUserId: input.userId
        }
      });

      await registerDependencyEdgeInTransaction(tx, {
        upstreamNodeId: sourceMap.nodeId,
        downstreamNodeId: node.id,
        relation: DependencyRelation.REFERENCES,
        reason:
          "Creative Brief is authored against this exact approved Music Map version."
      });

      await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        briefVersionId: created.id
      });

      return serializeBriefVersion(tx, created.id);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function saveCreativeBrief(input: {
  userId: string;
  projectId: string;
  briefVersionId: string;
  expectedRevision: number;
  payload: CreativeBriefDraft;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });
  const payload = creativeBriefDraftSchema.parse(input.payload);

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });

      const changed = await tx.creativeBriefVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision,
          lifecycle: VersionLifecycle.DRAFT
        },
        data: {
          brief: toJson(payload),
          revision: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new CreativeBriefConflictError(
          "Creative Brief changed while autosave was being written."
        );
      }

      const synced = await syncWizardDraft(tx, {
        projectVersionId: projectVersion.id,
        briefVersionId: context.version.id
      });

      return {
        version: await serializeBriefVersion(tx, context.version.id),
        impactWarnings: synced.wizard.impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function completeCreativeBrief(input: {
  userId: string;
  projectId: string;
  briefVersionId: string;
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
      const brief = parseBrief(context.version.brief);
      const issues = creativeBriefCompletionIssues(brief);
      if (issues.length) {
        throw new CreativeBriefError(issues.join(" "));
      }

      const changed = await tx.creativeBriefVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision,
          lifecycle: VersionLifecycle.DRAFT
        },
        data: {
          revision: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new CreativeBriefConflictError(
          "Creative Brief changed while it was being completed."
        );
      }

      const refreshed = await refreshFingerprint(
        tx,
        context.version.id
      );
      const wizard = await completeAutomaticWizardStepInTransaction(
        tx,
        {
          projectVersionId: projectVersion.id,
          stepKey: "creative-brief",
          payload: await wizardPayload(tx, context.version.id),
          semanticFingerprint: refreshed.fingerprint
        }
      );

      return {
        version: await serializeBriefVersion(tx, context.version.id),
        impactWarnings: wizard.impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function reopenCreativeBrief(input: {
  userId: string;
  projectId: string;
  briefVersionId: string;
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
        return {
          version: await serializeBriefVersion(tx, context.version.id),
          impactWarnings: []
        };
      }

      await tx.wizardStepState.update({
        where: { id: context.step.id },
        data: {
          status: WizardStepStatus.IN_PROGRESS,
          completedAt: null,
          needsReviewAt: null,
          reviewReason: null
        }
      });
      await tx.wizardProgress.update({
        where: { id: context.progress.id },
        data: {
          revision: { increment: 1 },
          currentStepKey: "creative-brief"
        }
      });

      return {
        version: await serializeBriefVersion(tx, context.version.id),
        impactWarnings: []
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function lockCreativeBrief(input: {
  userId: string;
  projectId: string;
  briefVersionId: string;
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
        throw new CreativeBriefError(
          "Complete the Creative Brief before locking it."
        );
      }

      const now = new Date();
      const changed = await tx.creativeBriefVersion.updateMany({
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
        throw new CreativeBriefConflictError(
          "Creative Brief changed while it was being locked."
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

      return {
        version: await serializeBriefVersion(tx, context.version.id),
        impactWarnings: []
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function getCreativeBriefState(input: {
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
      musicMap: {
        select: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1,
            include: {
              anchors: {
                where: { decision: "ACCEPTED" },
                orderBy: [
                  { startMs: "asc" },
                  { position: "asc" }
                ],
                select: {
                  id: true,
                  kind: true,
                  label: true,
                  startMs: true,
                  endMs: true,
                  source: true
                }
              }
            }
          }
        }
      },
      creativeBrief: {
        select: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 5,
            include: {
              sourceMusicMapVersion: {
                include: {
                  anchors: {
                    where: { decision: "ACCEPTED" },
                    orderBy: [
                      { startMs: "asc" },
                      { position: "asc" }
                    ],
                    select: {
                      id: true,
                      kind: true,
                      label: true,
                      startMs: true,
                      endMs: true,
                      source: true
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
  if (!project) throw new CreativeBriefError("Project not found.");

  const latestMap = project.musicMap?.versions[0] ?? null;
  const versions =
    project.creativeBrief?.versions.map((version) => ({
      id: version.id,
      nodeId: version.nodeId,
      versionNumber: version.versionNumber,
      lifecycle: version.lifecycle,
      sourceMusicMapVersionId: version.sourceMusicMapVersionId,
      sourceMusicMapVersionNumber:
        version.sourceMusicMapVersion.versionNumber,
      revision: version.revision,
      brief: parseBrief(version.brief),
      createdAt: version.createdAt,
      lockedAt: version.lockedAt,
      sourceMusicMap: {
        id: version.sourceMusicMapVersion.id,
        versionNumber: version.sourceMusicMapVersion.versionNumber,
        lifecycle: version.sourceMusicMapVersion.lifecycle,
        tempoBpm: version.sourceMusicMapVersion.tempoBpm,
        meterNumerator: version.sourceMusicMapVersion.meterNumerator,
        meterDenominator: version.sourceMusicMapVersion.meterDenominator,
        durationMs: version.sourceMusicMapVersion.durationMs,
        acceptedAnchors: version.sourceMusicMapVersion.anchors
      }
    })) ?? [];

  return {
    latest: versions[0] ?? null,
    versions,
    latestMusicMap: latestMap
      ? {
          id: latestMap.id,
          versionNumber: latestMap.versionNumber,
          lifecycle: latestMap.lifecycle,
          tempoBpm: latestMap.tempoBpm,
          meterNumerator: latestMap.meterNumerator,
          meterDenominator: latestMap.meterDenominator,
          durationMs: latestMap.durationMs,
          acceptedAnchors: latestMap.anchors
        }
      : null,
    sourceReady:
      Boolean(latestMap) &&
      latestMap!.lifecycle === VersionLifecycle.LOCKED,
    needsRebase:
      Boolean(latestMap && versions[0]) &&
      latestMap!.id !== versions[0]!.sourceMusicMapVersionId
  };
}
