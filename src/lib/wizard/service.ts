import {
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { aspectRatioPresets } from "@/lib/projects/project-input";
import { projectSetupDraftSchema, type ProjectSetupDraft } from "./input";
import {
  getWizardStepDefinition,
  WIZARD_STEPS
} from "./registry";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class WizardError extends Error {}
export class WizardConflictError extends WizardError {}
export class WizardLockedError extends WizardError {}

function requireRegisteredStep(stepKey: string) {
  const definition = getWizardStepDefinition(stepKey);
  if (!definition) {
    throw new WizardError("Unknown wizard step: " + stepKey);
  }
  return definition;
}

function initialSetupPayload(version: {
  title: string;
  description: string | null;
  aspectRatio: string | null;
  frameRate: number | null;
}): ProjectSetupDraft {
  const aspectRatio =
    version.aspectRatio &&
    ["16:9", "9:16", "1:1", "4:3", "2.39:1"].includes(version.aspectRatio)
      ? (version.aspectRatio as ProjectSetupDraft["aspectRatio"])
      : "16:9";

  return {
    title: version.title,
    description: version.description ?? "",
    aspectRatio,
    frameRate:
      version.frameRate &&
      [23.976, 24, 25, 29.97, 30, 60].includes(version.frameRate)
        ? version.frameRate
        : 24
  };
}

function isTouchedStep(step: {
  status: WizardStepStatus;
  payload: Prisma.JsonValue | null;
  completedAt: Date | null;
  lockedAt: Date | null;
}): boolean {
  return (
    step.status !== WizardStepStatus.NOT_STARTED ||
    step.payload !== null ||
    step.completedAt !== null ||
    step.lockedAt !== null
  );
}

async function loadLatestProjectVersionForUser(
  userId: string,
  projectId: string
) {
  return db.projectVersion.findFirst({
    where: {
      projectId,
      project: {
        archivedAt: null,
        ...projectEditorWhere(userId)
      }
    },
    orderBy: { versionNumber: "desc" },
    include: {
      project: true,
      wizardProgress: {
        include: {
          steps: {
            orderBy: { ordinal: "asc" }
          }
        }
      }
    }
  });
}

export async function ensureWizardProgress(input: {
  userId: string;
  projectId: string;
}) {
  let version = await loadLatestProjectVersionForUser(
    input.userId,
    input.projectId
  );
  if (!version) {
    throw new WizardError("Project not found.");
  }

  if (!version.wizardProgress) {
    const setup = initialSetupPayload(version);
    try {
      await db.wizardProgress.create({
        data: {
          projectVersionId: version.id,
          currentStepKey: "project-setup",
          steps: {
            create: WIZARD_STEPS.map((step) => {
              if (step.key === "project-setup") {
                return {
                  stepKey: step.key,
                  ordinal: step.ordinal,
                  status: WizardStepStatus.IN_PROGRESS,
                  payload: setup,
                  payloadFingerprint: fingerprintJson(
                    setup as Prisma.JsonValue
                  ),
                  contentRevision: 1,
                  lastSavedAt: new Date()
                };
              }
              return {
                stepKey: step.key,
                ordinal: step.ordinal
              };
            })
          }
        }
      });
    } catch (error) {
      if (
        !(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
      ) {
        throw error;
      }
    }

    version = await loadLatestProjectVersionForUser(
      input.userId,
      input.projectId
    );
    if (!version?.wizardProgress) {
      throw new WizardError("Wizard progress could not be initialized.");
    }
  }

  const existingKeys = new Set(
    version.wizardProgress.steps.map((step) => step.stepKey)
  );
  const missingSteps = WIZARD_STEPS.filter(
    (step) => !existingKeys.has(step.key)
  );
  if (missingSteps.length > 0) {
    await db.wizardStepState.createMany({
      data: missingSteps.map((step) => ({
        wizardProgressId: version!.wizardProgress!.id,
        stepKey: step.key,
        ordinal: step.ordinal
      })),
      skipDuplicates: true
    });
    version = await loadLatestProjectVersionForUser(
      input.userId,
      input.projectId
    );
  }

  if (!version?.wizardProgress) {
    throw new WizardError("Wizard progress is unavailable.");
  }

  return version;
}

export async function getWizardView(input: {
  userId: string;
  projectId: string;
  selectedStepKey?: string;
}) {
  const version = await ensureWizardProgress(input);
  const progress = version.wizardProgress!;
  const fallbackDefinition = WIZARD_STEPS[0];
  if (!fallbackDefinition) {
    throw new WizardError("Wizard registry is empty.");
  }
  const selectedDefinition =
    (input.selectedStepKey &&
      getWizardStepDefinition(input.selectedStepKey)) ||
    getWizardStepDefinition(progress.currentStepKey) ||
    fallbackDefinition;

  const selectedState = progress.steps.find(
    (step) => step.stepKey === selectedDefinition.key
  );
  if (!selectedState) {
    throw new WizardError("Selected wizard step state is unavailable.");
  }

  const downstreamImpact = progress.steps
    .filter(
      (step) =>
        step.ordinal > selectedState.ordinal && isTouchedStep(step)
    )
    .map((step) => ({
      stepKey: step.stepKey,
      title:
        getWizardStepDefinition(step.stepKey)?.title ?? step.stepKey,
      status: step.status,
      locked: Boolean(step.lockedAt)
    }));

  return {
    project: version.project,
    projectVersion: {
      id: version.id,
      nodeId: version.nodeId,
      versionNumber: version.versionNumber,
      lifecycle: version.lifecycle,
      audioMasterAssetVersionId: version.audioMasterAssetVersionId
    },
    progress: {
      id: progress.id,
      currentStepKey: progress.currentStepKey,
      revision: progress.revision
    },
    steps: WIZARD_STEPS.map((definition) => {
      const state = progress.steps.find(
        (candidate) => candidate.stepKey === definition.key
      );
      if (!state) {
        throw new WizardError(
          "Wizard step state is missing: " + definition.key
        );
      }
      return {
        definition,
        state
      };
    }),
    selected: {
      definition: selectedDefinition,
      state: selectedState
    },
    downstreamImpact
  };
}

async function loadMutationContext(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    projectId: string;
    expectedRevision: number;
    stepKey: string;
  }
) {
  const definition = requireRegisteredStep(input.stepKey);
  const progress = await tx.wizardProgress.findFirst({
    where: {
      projectVersion: {
        projectId: input.projectId,
        project: {
          ...projectEditorWhere(input.userId)
        }
      }
    },
    orderBy: {
      projectVersion: {
        versionNumber: "desc"
      }
    },
    include: {
      projectVersion: {
        include: {
          project: true
        }
      },
      steps: {
        orderBy: { ordinal: "asc" }
      }
    }
  });

  if (!progress) {
    throw new WizardError("Wizard progress not found.");
  }
  if (progress.revision !== input.expectedRevision) {
    throw new WizardConflictError(
      "Wizard progress changed in another request. Reload before continuing."
    );
  }
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError(
      "This project version is locked and cannot be changed."
    );
  }

  const step = progress.steps.find(
    (candidate) => candidate.stepKey === input.stepKey
  );
  if (!step) {
    throw new WizardError("Wizard step state not found.");
  }

  return { definition, progress, step };
}

async function invalidateTouchedDownstream(
  tx: Prisma.TransactionClient,
  input: {
    progressId: string;
    sourceOrdinal: number;
    sourceTitle: string;
    steps: Array<{
      id: string;
      ordinal: number;
      stepKey: string;
      status: WizardStepStatus;
      payload: Prisma.JsonValue | null;
      completedAt: Date | null;
      lockedAt: Date | null;
    }>;
  }
) {
  const affected = input.steps.filter(
    (step) =>
      step.ordinal > input.sourceOrdinal && isTouchedStep(step)
  );
  if (affected.length === 0) return [];

  const now = new Date();
  await tx.wizardStepState.updateMany({
    where: {
      wizardProgressId: input.progressId,
      id: { in: affected.map((step) => step.id) }
    },
    data: {
      status: WizardStepStatus.NEEDS_REVIEW,
      needsReviewAt: now,
      reviewReason:
        'Upstream wizard step "' +
        input.sourceTitle +
        '" changed after this stage had work.'
    }
  });

  return affected.map((step) => ({
    stepKey: step.stepKey,
    title:
      getWizardStepDefinition(step.stepKey)?.title ?? step.stepKey,
    locked: Boolean(step.lockedAt)
  }));
}

export async function saveWizardStepPayload(input: {
  userId: string;
  projectId: string;
  stepKey: string;
  expectedRevision: number;
  payload: unknown;
}) {
  const definition = requireRegisteredStep(input.stepKey);
  if (!definition.editor) {
    throw new WizardError(
      "This stage does not have an editor installed in the current build."
    );
  }

  if (definition.editor !== "project-setup") {
    throw new WizardError(
      "This wizard stage is managed by its stage-specific service."
    );
  }

  const parsedPayload = projectSetupDraftSchema.parse(input.payload);

  return db.$transaction(
    async (tx) => {
      const context = await loadMutationContext(tx, input);
      if (context.step.lockedAt) {
        throw new WizardLockedError(
          "This wizard step is locked and cannot be edited."
        );
      }

      const payload = parsedPayload as Prisma.InputJsonValue;
      const fingerprint = fingerprintJson(payload as Prisma.JsonValue);

      if (fingerprint === context.step.payloadFingerprint) {
        return {
          progressRevision: context.progress.revision,
          changed: false,
          impactWarnings: []
        };
      }

      if (context.definition.editor === "project-setup") {
        const setup = parsedPayload as ProjectSetupDraft;
        const dimensions = aspectRatioPresets[setup.aspectRatio];

        await tx.project.update({
          where: { id: context.progress.projectVersion.projectId },
          data: {
            title: setup.title,
            description: setup.description || null
          }
        });
        await tx.projectVersion.update({
          where: { id: context.progress.projectVersionId },
          data: {
            title: setup.title,
            description: setup.description || null,
            aspectRatio: setup.aspectRatio,
            outputWidth: dimensions.width,
            outputHeight: dimensions.height,
            frameRate: setup.frameRate
          }
        });
      }

      const impactWarnings = await invalidateTouchedDownstream(tx, {
        progressId: context.progress.id,
        sourceOrdinal: context.step.ordinal,
        sourceTitle: context.definition.title,
        steps: context.progress.steps
      });

      await tx.wizardStepState.update({
        where: { id: context.step.id },
        data: {
          payload,
          payloadFingerprint: fingerprint,
          contentRevision: { increment: 1 },
          status: WizardStepStatus.IN_PROGRESS,
          completedAt: null,
          needsReviewAt: null,
          reviewReason: null,
          lastSavedAt: new Date()
        }
      });

      const updated = await tx.wizardProgress.updateMany({
        where: {
          id: context.progress.id,
          revision: input.expectedRevision
        },
        data: {
          revision: { increment: 1 },
          currentStepKey: input.stepKey
        }
      });
      if (updated.count !== 1) {
        throw new WizardConflictError(
          "Wizard progress changed while this autosave was being written."
        );
      }

      return {
        progressRevision: input.expectedRevision + 1,
        changed: true,
        impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function transitionWizardStep(input: {
  userId: string;
  projectId: string;
  stepKey: string;
  expectedRevision: number;
  action: "complete" | "lock" | "reopen";
}) {
  return db.$transaction(
    async (tx) => {
      const context = await loadMutationContext(tx, input);
      if (!context.definition.editor) {
        throw new WizardError(
          "This stage does not have an editor installed in the current build."
        );
      }
      if (
        context.definition.editor === "music-map" ||
        context.definition.editor === "creative-brief" ||
        context.definition.editor === "concepts" ||
        context.definition.editor === "treatment" ||
        context.definition.editor === "creative-language" ||
        context.definition.editor === "song-picture-plan"
      ) {
        throw new WizardError(
          "This stage's completion and locking are managed by its stage-specific service."
        );
      }
      if (
        context.definition.editor === "music-analysis" &&
        input.action !== "lock"
      ) {
        throw new WizardError(
          "This stage's completion and revision flow is managed by its stage-specific service."
        );
      }
      let impactWarnings: Array<{
        stepKey: string;
        title: string;
        locked: boolean;
      }> = [];

      if (input.action === "complete") {
        if (context.step.lockedAt) {
          throw new WizardLockedError(
            "This wizard step is already locked."
          );
        }
        await tx.wizardStepState.update({
          where: { id: context.step.id },
          data: {
            status: WizardStepStatus.COMPLETED,
            completedAt: new Date(),
            needsReviewAt: null,
            reviewReason: null
          }
        });
      } else if (input.action === "lock") {
        if (context.step.lockedAt) {
          return {
            progressRevision: context.progress.revision,
            status: context.step.status,
            locked: true,
            impactWarnings: []
          };
        }
        if (context.step.status !== WizardStepStatus.COMPLETED) {
          throw new WizardError(
            "A wizard step must be completed before it can be locked."
          );
        }
        await tx.wizardStepState.update({
          where: { id: context.step.id },
          data: { lockedAt: new Date() }
        });
      } else {
        if (context.step.lockedAt) {
          throw new WizardLockedError(
            "A locked wizard step cannot be reopened in this project version."
          );
        }

        impactWarnings = await invalidateTouchedDownstream(tx, {
          progressId: context.progress.id,
          sourceOrdinal: context.step.ordinal,
          sourceTitle: context.definition.title,
          steps: context.progress.steps
        });
        await tx.wizardStepState.update({
          where: { id: context.step.id },
          data: {
            status: WizardStepStatus.IN_PROGRESS,
            completedAt: null,
            needsReviewAt: null,
            reviewReason: null
          }
        });
      }

      const updated = await tx.wizardProgress.updateMany({
        where: {
          id: context.progress.id,
          revision: input.expectedRevision
        },
        data: {
          revision: { increment: 1 },
          currentStepKey: input.stepKey
        }
      });
      if (updated.count !== 1) {
        throw new WizardConflictError(
          "Wizard progress changed while this transition was being written."
        );
      }

      return {
        progressRevision: input.expectedRevision + 1,
        status:
          input.action === "complete"
            ? WizardStepStatus.COMPLETED
            : input.action === "reopen"
              ? WizardStepStatus.IN_PROGRESS
              : context.step.status,
        locked: input.action === "lock" || Boolean(context.step.lockedAt),
        impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function navigateWizard(input: {
  userId: string;
  projectId: string;
  stepKey: string;
}) {
  requireRegisteredStep(input.stepKey);
  const version = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });
  const progress = version.wizardProgress!;

  await db.wizardProgress.update({
    where: { id: progress.id },
    data: {
      currentStepKey: input.stepKey
    }
  });

  return { currentStepKey: input.stepKey };
}


export async function prepareAutomaticWizardStepInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    projectVersionId: string;
    stepKey: string;
    payload: Prisma.InputJsonValue;
    semanticFingerprint?: string;
  }
) {
  const definition = requireRegisteredStep(input.stepKey);
  if (!definition.editor) {
    throw new WizardError("Wizard stage has no installed editor.");
  }

  const progress = await tx.wizardProgress.findUnique({
    where: { projectVersionId: input.projectVersionId },
    include: {
      projectVersion: true,
      steps: { orderBy: { ordinal: "asc" } }
    }
  });
  if (!progress) {
    throw new WizardError("Wizard progress not found for project version.");
  }
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError(
      "This project version is locked and cannot be changed."
    );
  }

  const step = progress.steps.find(
    (candidate) => candidate.stepKey === input.stepKey
  );
  if (!step) throw new WizardError("Wizard step state not found.");
  if (step.lockedAt) {
    throw new WizardLockedError(
      "This wizard step is locked and cannot be regenerated."
    );
  }

  await tx.wizardStepState.update({
    where: { id: step.id },
    data: {
      status: WizardStepStatus.IN_PROGRESS,
      payload: input.payload,
      contentRevision: { increment: 1 },
      lastSavedAt: new Date(),
      completedAt: null,
      needsReviewAt: null,
      reviewReason: null
    }
  });

  await tx.wizardProgress.update({
    where: { id: progress.id },
    data: {
      revision: { increment: 1 },
      currentStepKey: input.stepKey
    }
  });

  return {
    progressId: progress.id,
    stepId: step.id,
    progressRevision: progress.revision + 1
  };
}

export async function prepareAutomaticWizardStep(input: {
  userId: string;
  projectId: string;
  stepKey: string;
  payload: Prisma.InputJsonValue;
}) {
  const version = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction((tx) =>
    prepareAutomaticWizardStepInTransaction(tx, {
      projectVersionId: version.id,
      stepKey: input.stepKey,
      payload: input.payload
    })
  );
}

export async function saveManagedWizardStepInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    projectVersionId: string;
    stepKey: string;
    payload: Prisma.InputJsonValue;
    semanticFingerprint: string;
  }
) {
  const definition = requireRegisteredStep(input.stepKey);
  const progress = await tx.wizardProgress.findUnique({
    where: { projectVersionId: input.projectVersionId },
    include: {
      projectVersion: true,
      steps: {
        orderBy: { ordinal: "asc" }
      }
    }
  });
  if (!progress) {
    throw new WizardError("Wizard progress not found for project version.");
  }
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError(
      "This project version is locked and cannot be changed."
    );
  }

  const step = progress.steps.find(
    (candidate) => candidate.stepKey === input.stepKey
  );
  if (!step) throw new WizardError("Wizard step state not found.");
  if (step.lockedAt) {
    throw new WizardLockedError(
      "This wizard step is locked and cannot be changed."
    );
  }

  const materialChange =
    Boolean(step.payloadFingerprint) &&
    step.payloadFingerprint !== input.semanticFingerprint;

  const impactWarnings = materialChange
    ? await invalidateTouchedDownstream(tx, {
        progressId: progress.id,
        sourceOrdinal: step.ordinal,
        sourceTitle: definition.title,
        steps: progress.steps
      })
    : [];

  const shouldOpen =
    !step.payloadFingerprint ||
    materialChange ||
    step.status === WizardStepStatus.NOT_STARTED;

  await tx.wizardStepState.update({
    where: { id: step.id },
    data: {
      payload: input.payload,
      payloadFingerprint: input.semanticFingerprint,
      contentRevision: { increment: 1 },
      lastSavedAt: new Date(),
      ...(shouldOpen
        ? {
            status: WizardStepStatus.IN_PROGRESS,
            completedAt: null,
            needsReviewAt: null,
            reviewReason: null
          }
        : {})
    }
  });

  await tx.wizardProgress.update({
    where: { id: progress.id },
    data: {
      revision: { increment: 1 },
      currentStepKey: input.stepKey
    }
  });

  return {
    materialChange,
    impactWarnings
  };
}

export async function completeAutomaticWizardStepInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    projectVersionId: string;
    stepKey: string;
    payload: Prisma.InputJsonValue;
    semanticFingerprint?: string;
  }
) {
  const definition = requireRegisteredStep(input.stepKey);
  const progress = await tx.wizardProgress.findUnique({
    where: { projectVersionId: input.projectVersionId },
    include: {
      steps: {
        orderBy: { ordinal: "asc" }
      }
    }
  });
  if (!progress) {
    throw new WizardError("Wizard progress not found for project version.");
  }

  const step = progress.steps.find(
    (candidate) => candidate.stepKey === input.stepKey
  );
  if (!step) throw new WizardError("Wizard step state not found.");
  if (step.lockedAt) {
    throw new WizardLockedError(
      "This wizard step is locked and cannot accept a new result."
    );
  }

  const fingerprint =
    input.semanticFingerprint ??
    fingerprintJson(input.payload as Prisma.JsonValue);
  const materialChange =
    Boolean(step.payloadFingerprint) &&
    step.payloadFingerprint !== fingerprint;

  const impactWarnings = materialChange
    ? await invalidateTouchedDownstream(tx, {
        progressId: progress.id,
        sourceOrdinal: step.ordinal,
        sourceTitle: definition.title,
        steps: progress.steps
      })
    : [];

  await tx.wizardStepState.update({
    where: { id: step.id },
    data: {
      status: WizardStepStatus.COMPLETED,
      payload: input.payload,
      payloadFingerprint: fingerprint,
      contentRevision: { increment: 1 },
      lastSavedAt: new Date(),
      completedAt: new Date(),
      needsReviewAt: null,
      reviewReason: null
    }
  });

  await tx.wizardProgress.update({
    where: { id: progress.id },
    data: {
      revision: { increment: 1 },
      currentStepKey: input.stepKey
    }
  });

  return {
    materialChange,
    impactWarnings
  };
}
