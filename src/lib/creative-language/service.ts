import {
  DependencyRelation,
  DomainVersionKind,
  GenerationKind,
  GenerationStatus,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { getEnvironment } from "@/lib/env";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import {
  getConfiguredTextProvider,
  textGenerationAvailable
} from "@/lib/text-generation/factory";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import { treatmentDocumentSchema } from "@/lib/treatment/schema";
import { queuedCreativeLanguageGenerationSchema } from "./input";
import {
  creativeLanguageCompletionIssues,
  creativeLanguageDocumentSchema,
  creativeLanguageDraftSchema,
  EMPTY_CREATIVE_LANGUAGE,
  type CreativeLanguageDraft
} from "./schema";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class CreativeLanguageError extends Error {}
export class CreativeLanguageConflictError extends CreativeLanguageError {}

type Tx = Prisma.TransactionClient;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function latestLockedTreatment(tx: Tx, projectId: string) {
  return tx.treatmentVersion.findFirst({
    where: {
      treatment: { projectId },
      lifecycle: VersionLifecycle.LOCKED
    },
    orderBy: { versionNumber: "desc" },
    include: {
      treatment: { include: { project: true } }
    }
  });
}

function semanticFingerprint(input: {
  sourceTreatmentVersionId: string;
  document: CreativeLanguageDraft;
}) {
  return fingerprintJson(toJson(input) as unknown as Prisma.JsonValue);
}

async function refreshFingerprint(
  tx: Tx,
  creativeLanguageVersionId: string
) {
  const version = await tx.creativeLanguageVersion.findUniqueOrThrow({
    where: { id: creativeLanguageVersionId }
  });
  const document = creativeLanguageDraftSchema.parse(version.document);
  const fingerprint = semanticFingerprint({
    sourceTreatmentVersionId: version.sourceTreatmentVersionId,
    document
  });
  await tx.domainVersionNode.update({
    where: { id: version.nodeId },
    data: { fingerprint }
  });
  return { fingerprint, document, nodeId: version.nodeId };
}

async function wizardPayload(
  tx: Tx,
  creativeLanguageVersionId: string
) {
  const version = await tx.creativeLanguageVersion.findUniqueOrThrow({
    where: { id: creativeLanguageVersionId },
    include: { sourceTreatmentVersion: true }
  });
  const document = creativeLanguageDraftSchema.parse(version.document);
  return toJson({
    creativeLanguageVersionId: version.id,
    creativeLanguageNodeId: version.nodeId,
    creativeLanguageRevision: version.revision,
    sourceTreatmentVersionId: version.sourceTreatmentVersionId,
    sourceTreatmentVersionNumber:
      version.sourceTreatmentVersion.versionNumber,
    characterCount: document.characters.length,
    locationCount: document.locations.length,
    motifCount: document.motifsAndProps.length
  });
}

async function syncWizard(
  tx: Tx,
  projectVersionId: string,
  creativeLanguageVersionId: string
) {
  const refreshed = await refreshFingerprint(
    tx,
    creativeLanguageVersionId
  );
  const wizard = await saveManagedWizardStepInTransaction(tx, {
    projectVersionId,
    stepKey: "creative-language",
    payload: await wizardPayload(tx, creativeLanguageVersionId),
    semanticFingerprint: refreshed.fingerprint
  });
  return { ...refreshed, wizard };
}

async function serializeCreativeLanguage(
  tx: Tx,
  creativeLanguageVersionId: string
) {
  const version = await tx.creativeLanguageVersion.findUniqueOrThrow({
    where: { id: creativeLanguageVersionId },
    include: {
      sourceTreatmentVersion: true
    }
  });
  return {
    id: version.id,
    nodeId: version.nodeId,
    versionNumber: version.versionNumber,
    lifecycle: version.lifecycle,
    revision: version.revision,
    sourceTreatmentVersionId: version.sourceTreatmentVersionId,
    sourceTreatmentVersionNumber:
      version.sourceTreatmentVersion.versionNumber,
    document: creativeLanguageDraftSchema.parse(version.document),
    generationJobId: version.generationJobId,
    createdAt: version.createdAt,
    lockedAt: version.lockedAt
  };
}

async function mutationContext(
  tx: Tx,
  input: {
    userId: string;
    projectId: string;
    projectVersionId: string;
    creativeLanguageVersionId: string;
    expectedRevision: number;
  }
) {
  const version = await tx.creativeLanguageVersion.findFirst({
    where: {
      id: input.creativeLanguageVersionId,
      creativeLanguage: {
        projectId: input.projectId,
        project: {
          ...projectEditorWhere(input.userId)
        }
      }
    }
  });
  if (!version) {
    throw new CreativeLanguageError(
      "Creative Language version not found."
    );
  }
  if (version.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This Creative Language version is locked.");
  }
  if (version.revision !== input.expectedRevision) {
    throw new CreativeLanguageConflictError(
      "Creative Language changed in another request. Reload before continuing."
    );
  }

  const progress = await tx.wizardProgress.findFirst({
    where: { projectVersionId: input.projectVersionId },
    include: { projectVersion: true, steps: true }
  });
  if (
    !progress ||
    progress.projectVersion.projectId !== input.projectId
  ) {
    throw new CreativeLanguageError("Wizard progress not found.");
  }
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError(
      "This project version is locked."
    );
  }
  const step = progress.steps.find(
    (item) => item.stepKey === "creative-language"
  );
  if (!step) {
    throw new CreativeLanguageError(
      "Creative Language wizard state is unavailable."
    );
  }
  if (step.lockedAt) {
    throw new WizardLockedError("Creative Language is locked.");
  }
  return { version, progress, step };
}

async function activeJob(tx: Tx, nodeId: string) {
  return tx.generationJob.findFirst({
    where: {
      kind: GenerationKind.TEXT,
      status: {
        in: [GenerationStatus.QUEUED, GenerationStatus.RUNNING]
      },
      inputs: {
        some: { nodeId, role: "creative-language" }
      }
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function initializeCreativeLanguage(input: {
  userId: string;
  projectId: string;
}) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(
    async (tx) => {
      const source = await latestLockedTreatment(tx, input.projectId);
      if (!source) {
        throw new CreativeLanguageError(
          "Complete and lock Treatment before starting Creative Language."
        );
      }
      treatmentDocumentSchema.parse(source.document);

      const logical = await tx.creativeLanguage.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId },
        update: {}
      });
      const latest = await tx.creativeLanguageVersion.findFirst({
        where: { creativeLanguageId: logical.id },
        orderBy: { versionNumber: "desc" }
      });

      if (
        latest &&
        latest.lifecycle === VersionLifecycle.DRAFT &&
        latest.sourceTreatmentVersionId === source.id
      ) {
        await syncWizard(tx, projectVersion.id, latest.id);
        return serializeCreativeLanguage(tx, latest.id);
      }

      if (latest?.lifecycle === VersionLifecycle.DRAFT) {
        await tx.creativeLanguageVersion.update({
          where: { id: latest.id },
          data: { lifecycle: VersionLifecycle.SUPERSEDED }
        });
      }

      const node = await tx.domainVersionNode.create({
        data: { kind: DomainVersionKind.CREATIVE_LANGUAGE }
      });
      const created = await tx.creativeLanguageVersion.create({
        data: {
          creativeLanguageId: logical.id,
          nodeId: node.id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          sourceTreatmentVersionId: source.id,
          document: toJson(EMPTY_CREATIVE_LANGUAGE),
          createdByUserId: input.userId
        }
      });

      await registerDependencyEdgeInTransaction(tx, {
        upstreamNodeId: source.nodeId,
        downstreamNodeId: node.id,
        relation: DependencyRelation.REFERENCES,
        reason:
          "Creative Language translates this exact locked Treatment into reusable project-wide rules."
      });
      await syncWizard(tx, projectVersion.id, created.id);
      return serializeCreativeLanguage(tx, created.id);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function saveCreativeLanguage(input: {
  userId: string;
  projectId: string;
  creativeLanguageVersionId: string;
  expectedRevision: number;
  document: CreativeLanguageDraft;
}) {
  const projectVersion = await ensureWizardProgress(input);
  const document = creativeLanguageDraftSchema.parse(input.document);

  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });
      if (await activeJob(tx, context.version.nodeId)) {
        throw new CreativeLanguageError(
          "Wait for Creative Language generation to finish before editing."
        );
      }

      const changed = await tx.creativeLanguageVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision,
          lifecycle: VersionLifecycle.DRAFT
        },
        data: {
          document: toJson(document),
          revision: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new CreativeLanguageConflictError(
          "Creative Language changed while saving."
        );
      }

      const synced = await syncWizard(
        tx,
        projectVersion.id,
        context.version.id
      );
      return {
        version: await serializeCreativeLanguage(
          tx,
          context.version.id
        ),
        impactWarnings: synced.wizard.impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function queueCreativeLanguageGeneration(input: {
  userId: string;
  projectId: string;
  creativeLanguageVersionId: string;
  expectedRevision: number;
  direction: string;
}) {
  const projectVersion = await ensureWizardProgress(input);
  const env = getEnvironment();
  const configured = getConfiguredTextProvider(env);

  const context = await db.$transaction(async (tx) => {
    const current = await mutationContext(tx, {
      ...input,
      projectVersionId: projectVersion.id
    });
    if (await activeJob(tx, current.version.nodeId)) {
      throw new CreativeLanguageError(
        "A Creative Language generation job is already active."
      );
    }
    const source = await tx.treatmentVersion.findUniqueOrThrow({
      where: { id: current.version.sourceTreatmentVersionId }
    });
    return {
      nodeId: current.version.nodeId,
      sourceNodeId: source.nodeId,
      sourceTreatmentVersionId:
        current.version.sourceTreatmentVersionId
    };
  });

  const request = queuedCreativeLanguageGenerationSchema.parse({
    textOperation: "creative-language",
    projectId: input.projectId,
    projectVersionId: projectVersion.id,
    creativeLanguageVersionId: input.creativeLanguageVersionId,
    treatmentVersionId: context.sourceTreatmentVersionId,
    direction: input.direction
  });

  const project = await db.project.findUniqueOrThrow({
    where: { id: input.projectId },
    select: { workspaceId: true }
  });

  const job = await enqueueGenerationJob({
    workspaceId: project.workspaceId,
    projectId: input.projectId,
    kind: GenerationKind.TEXT,
    providerKey: configured.provider.key + ":creative-language",
    modelKey: configured.model,
    requestSnapshot: toJson(request),
    requestedByUserId: input.userId,
    inputs: [
      {
        nodeId: context.sourceNodeId,
        role: "treatment"
      },
      {
        nodeId: context.nodeId,
        role: "creative-language"
      }
    ],
    prepare: async (tx, jobId) => {
      await tx.creativeLanguageVersion.update({
        where: { id: input.creativeLanguageVersionId },
        data: { generationJobId: jobId }
      });
    }
  });

  return { jobId: job.id, status: job.status };
}

export async function persistCreativeLanguageGeneration(input: {
  generationJobId: string;
  creativeLanguageVersionId: string;
  treatmentVersionId: string;
  document: unknown;
}) {
  const document = creativeLanguageDocumentSchema.parse(input.document);

  return db.$transaction(
    async (tx) => {
      const version =
        await tx.creativeLanguageVersion.findUniqueOrThrow({
          where: { id: input.creativeLanguageVersionId }
        });

      if (
        version.sourceTreatmentVersionId !== input.treatmentVersionId ||
        version.generationJobId !== input.generationJobId ||
        version.lifecycle !== VersionLifecycle.DRAFT
      ) {
        throw new CreativeLanguageError(
          "Creative Language generation no longer matches its pinned Treatment."
        );
      }

      const existing = await tx.generationOutput.findFirst({
        where: {
          jobId: input.generationJobId,
          role: "creative-language"
        }
      });
      if (existing) {
        return {
          creativeLanguageVersionId: version.id,
          nodeId: version.nodeId
        };
      }

      await tx.creativeLanguageVersion.update({
        where: { id: version.id },
        data: {
          document: toJson(document),
          revision: { increment: 1 }
        }
      });
      await tx.generationOutput.create({
        data: {
          jobId: input.generationJobId,
          nodeId: version.nodeId,
          role: "creative-language"
        }
      });

      const job = await tx.generationJob.findUniqueOrThrow({
        where: { id: input.generationJobId }
      });
      const request = queuedCreativeLanguageGenerationSchema.parse(
        job.requestSnapshot
      );
      await syncWizard(
        tx,
        request.projectVersionId,
        version.id
      );

      return {
        creativeLanguageVersionId: version.id,
        nodeId: version.nodeId
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function completeCreativeLanguage(input: {
  userId: string;
  projectId: string;
  creativeLanguageVersionId: string;
  expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });
      if (await activeJob(tx, context.version.nodeId)) {
        throw new CreativeLanguageError(
          "Wait for generation to finish before completing Creative Language."
        );
      }

      const draft = creativeLanguageDraftSchema.parse(
        context.version.document
      );
      const issues = creativeLanguageCompletionIssues(draft);
      if (issues.length) {
        throw new CreativeLanguageError(issues.join(" "));
      }

      const changed = await tx.creativeLanguageVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision
        },
        data: { revision: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new CreativeLanguageConflictError(
          "Creative Language changed while completing."
        );
      }

      const refreshed = await refreshFingerprint(
        tx,
        context.version.id
      );
      const wizard =
        await completeAutomaticWizardStepInTransaction(tx, {
          projectVersionId: projectVersion.id,
          stepKey: "creative-language",
          payload: await wizardPayload(tx, context.version.id),
          semanticFingerprint: refreshed.fingerprint
        });

      return {
        version: await serializeCreativeLanguage(
          tx,
          context.version.id
        ),
        impactWarnings: wizard.impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function reopenCreativeLanguage(input: {
  userId: string;
  projectId: string;
  creativeLanguageVersionId: string;
  expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(async (tx) => {
    const context = await mutationContext(tx, {
      ...input,
      projectVersionId: projectVersion.id
    });

    if (context.step.status !== WizardStepStatus.COMPLETED) {
      return {
        version: await serializeCreativeLanguage(
          tx,
          context.version.id
        ),
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
        currentStepKey: "creative-language"
      }
    });

    return {
      version: await serializeCreativeLanguage(
        tx,
        context.version.id
      ),
      impactWarnings: []
    };
  });
}

export async function lockCreativeLanguage(input: {
  userId: string;
  projectId: string;
  creativeLanguageVersionId: string;
  expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(
    async (tx) => {
      const context = await mutationContext(tx, {
        ...input,
        projectVersionId: projectVersion.id
      });
      if (context.step.status !== WizardStepStatus.COMPLETED) {
        throw new CreativeLanguageError(
          "Complete Creative Language before locking it."
        );
      }

      const now = new Date();
      const changed = await tx.creativeLanguageVersion.updateMany({
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
        throw new CreativeLanguageConflictError(
          "Creative Language changed while locking."
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
        version: await serializeCreativeLanguage(
          tx,
          context.version.id
        ),
        impactWarnings: []
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function getCreativeLanguageState(input: {
  userId: string;
  projectId: string;
}) {
  const project = await db.project.findFirst({
    where: {
      id: input.projectId,
      ...projectEditorWhere(input.userId)
    },
    include: {
      treatment: {
        include: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1
          }
        }
      },
      creativeLanguage: {
        include: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1
          }
        }
      }
    }
  });
  if (!project) {
    throw new CreativeLanguageError("Project not found.");
  }

  const latestTreatment = project.treatment?.versions[0] ?? null;
  const latestRef = project.creativeLanguage?.versions[0] ?? null;
  const latest = latestRef
    ? await serializeCreativeLanguage(db, latestRef.id)
    : null;
  const recentJob = latestRef
    ? await db.generationJob.findFirst({
        where: {
          inputs: {
            some: {
              nodeId: latestRef.nodeId,
              role: "creative-language"
            }
          }
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          progressPercent: true,
          progressMessage: true,
          errorMessage: true
        }
      })
    : null;

  let providerAvailable = false;
  try {
    providerAvailable = textGenerationAvailable(getEnvironment());
  } catch {}

  return {
    latest,
    latestTreatment,
    recentJob,
    providerAvailable,
    sourceReady: Boolean(
      latestTreatment &&
        latestTreatment.lifecycle === VersionLifecycle.LOCKED
    ),
    needsRebase: Boolean(
      latestTreatment &&
        latest &&
        latestTreatment.id !== latest.sourceTreatmentVersionId
    )
  };
}
