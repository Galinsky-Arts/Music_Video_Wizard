import {
  ConceptLineageRole,
  ConceptOptionOrigin,
  DependencyRelation,
  DomainVersionKind,
  GenerationKind,
  GenerationStatus,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { getEnvironment } from "@/lib/env";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  prepareAutomaticWizardStepInTransaction,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import { creativeBriefDraftSchema } from "@/lib/creative-brief/input";
import {
  getConfiguredTextProvider,
  textGenerationAvailable
} from "@/lib/text-generation/factory";
import {
  conceptContentSchema,
  type ConceptContent
} from "./schema";
import {
  queuedConceptGenerationSchema,
  type QueuedConceptGeneration
} from "./input";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class ConceptError extends Error {}
export class ConceptConflictError extends ConceptError {}

type Tx = Prisma.TransactionClient;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseConcept(value: Prisma.JsonValue): ConceptContent {
  return conceptContentSchema.parse(value);
}

async function latestLockedBrief(tx: Tx, projectId: string) {
  return tx.creativeBriefVersion.findFirst({
    where: {
      creativeBrief: { projectId }
    },
    orderBy: { versionNumber: "desc" },
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
              kind: true,
              label: true,
              startMs: true,
              endMs: true
            }
          }
        }
      }
    }
  });
}

async function fullSemanticSnapshot(tx: Tx, conceptSetVersionId: string) {
  const version = await tx.conceptSetVersion.findUnique({
    where: { id: conceptSetVersionId },
    include: {
      options: {
        orderBy: { position: "asc" },
        include: {
          parentLinks: {
            orderBy: { position: "asc" },
            select: {
              role: true,
              position: true,
              parent: {
                select: { position: true }
              }
            }
          }
        }
      },
      selectedConcept: {
        select: { position: true }
      }
    }
  });
  if (!version) throw new ConceptError("Concept set version not found.");

  return {
    sourceCreativeBriefVersionId:
      version.sourceCreativeBriefVersionId,
    selectedPosition: version.selectedConcept?.position ?? null,
    options: version.options.map((option) => ({
      position: option.position,
      origin: option.origin,
      content: parseConcept(option.content),
      revisionInstruction: option.revisionInstruction,
      parents: option.parentLinks.map((link) => ({
        role: link.role,
        position: link.position,
        parentPosition: link.parent.position
      }))
    }))
  };
}

async function refreshConceptSetFingerprint(
  tx: Tx,
  conceptSetVersionId: string
) {
  const snapshot = await fullSemanticSnapshot(tx, conceptSetVersionId);
  const fingerprint = fingerprintJson(
    toJson(snapshot) as unknown as Prisma.JsonValue
  );
  const version = await tx.conceptSetVersion.findUniqueOrThrow({
    where: { id: conceptSetVersionId },
    select: { nodeId: true }
  });
  await tx.domainVersionNode.update({
    where: { id: version.nodeId },
    data: { fingerprint }
  });
  return { fingerprint, snapshot, nodeId: version.nodeId };
}

async function selectedSemanticFingerprint(
  tx: Tx,
  conceptSetVersionId: string
) {
  const version = await tx.conceptSetVersion.findUniqueOrThrow({
    where: { id: conceptSetVersionId },
    include: {
      selectedConcept: {
        select: {
          position: true,
          content: true
        }
      }
    }
  });

  return fingerprintJson(
    toJson({
      sourceCreativeBriefVersionId:
        version.sourceCreativeBriefVersionId,
      selectedConcept: version.selectedConcept
        ? {
            position: version.selectedConcept.position,
            content: parseConcept(version.selectedConcept.content)
          }
        : null
    }) as unknown as Prisma.JsonValue
  );
}

async function wizardPayload(tx: Tx, conceptSetVersionId: string) {
  const version = await tx.conceptSetVersion.findUniqueOrThrow({
    where: { id: conceptSetVersionId },
    include: {
      selectedConcept: {
        select: {
          id: true,
          position: true,
          content: true
        }
      },
      _count: {
        select: { options: true }
      }
    }
  });

  return toJson({
    conceptSetVersionId: version.id,
    conceptSetNodeId: version.nodeId,
    conceptSetRevision: version.revision,
    sourceCreativeBriefVersionId:
      version.sourceCreativeBriefVersionId,
    optionCount: version._count.options,
    selectedConceptId: version.selectedConcept?.id ?? null,
    selectedConceptPosition:
      version.selectedConcept?.position ?? null,
    selectedConceptTitle: version.selectedConcept
      ? parseConcept(version.selectedConcept.content).title
      : null
  });
}

async function syncWizardState(
  tx: Tx,
  input: {
    projectVersionId: string;
    conceptSetVersionId: string;
  }
) {
  await refreshConceptSetFingerprint(tx, input.conceptSetVersionId);
  return saveManagedWizardStepInTransaction(tx, {
    projectVersionId: input.projectVersionId,
    stepKey: "concepts",
    payload: await wizardPayload(tx, input.conceptSetVersionId),
    semanticFingerprint: await selectedSemanticFingerprint(
      tx,
      input.conceptSetVersionId
    )
  });
}

async function serializeConceptSet(
  tx: Tx,
  conceptSetVersionId: string
) {
  const version = await tx.conceptSetVersion.findUniqueOrThrow({
    where: { id: conceptSetVersionId },
    include: {
      sourceCreativeBriefVersion: {
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
                  kind: true,
                  label: true,
                  startMs: true,
                  endMs: true
                }
              }
            }
          }
        }
      },
      options: {
        orderBy: { position: "asc" },
        include: {
          parentLinks: {
            orderBy: { position: "asc" },
            select: {
              role: true,
              position: true,
              parentConceptId: true
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
    sourceCreativeBriefVersionId:
      version.sourceCreativeBriefVersionId,
    sourceCreativeBriefVersionNumber:
      version.sourceCreativeBriefVersion.versionNumber,
    revision: version.revision,
    selectedConceptId: version.selectedConceptId,
    createdAt: version.createdAt,
    lockedAt: version.lockedAt,
    creativeBrief: creativeBriefDraftSchema.parse(
      version.sourceCreativeBriefVersion.brief
    ),
    musicMap: {
      versionNumber:
        version.sourceCreativeBriefVersion
          .sourceMusicMapVersion.versionNumber,
      durationMs:
        version.sourceCreativeBriefVersion
          .sourceMusicMapVersion.durationMs,
      tempoBpm:
        version.sourceCreativeBriefVersion
          .sourceMusicMapVersion.tempoBpm,
      meterNumerator:
        version.sourceCreativeBriefVersion
          .sourceMusicMapVersion.meterNumerator,
      meterDenominator:
        version.sourceCreativeBriefVersion
          .sourceMusicMapVersion.meterDenominator,
      acceptedAnchors:
        version.sourceCreativeBriefVersion
          .sourceMusicMapVersion.anchors
    },
    options: version.options.map((option) => ({
      id: option.id,
      origin: option.origin,
      position: option.position,
      content: parseConcept(option.content),
      generationJobId: option.generationJobId,
      revisionInstruction: option.revisionInstruction,
      createdAt: option.createdAt,
      parents: option.parentLinks
    }))
  };
}

async function activeConceptJob(
  tx: Tx,
  nodeId: string,
  excludeJobId?: string
) {
  return tx.generationJob.findFirst({
    where: {
      id: excludeJobId ? { not: excludeJobId } : undefined,
      kind: GenerationKind.TEXT,
      status: {
        in: [
          GenerationStatus.QUEUED,
          GenerationStatus.RUNNING
        ]
      },
      inputs: {
        some: {
          nodeId,
          role: "concept-set"
        }
      }
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      progressPercent: true,
      progressMessage: true,
      errorMessage: true,
      createdAt: true
    }
  });
}

async function recentConceptJob(
  tx: Tx,
  nodeId: string
) {
  return tx.generationJob.findFirst({
    where: {
      kind: GenerationKind.TEXT,
      inputs: {
        some: {
          nodeId,
          role: "concept-set"
        }
      }
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      progressPercent: true,
      progressMessage: true,
      errorMessage: true,
      createdAt: true
    }
  });
}

async function mutationContext(
  tx: Tx,
  input: {
    userId: string;
    projectId: string;
    projectVersionId: string;
    conceptSetVersionId: string;
    expectedRevision: number;
  }
) {
  const version = await tx.conceptSetVersion.findFirst({
    where: {
      id: input.conceptSetVersionId,
      conceptSet: {
        projectId: input.projectId,
        project: {
          ...projectEditorWhere(input.userId)
        }
      }
    }
  });
  if (!version) throw new ConceptError("Concept set version not found.");
  if (version.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This concept set version is locked.");
  }
  if (version.revision !== input.expectedRevision) {
    throw new ConceptConflictError(
      "Concepts changed in another request. Reload before continuing."
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
  if (!progress) throw new ConceptError("Wizard progress not found.");
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This project version is locked.");
  }
  const step = progress.steps.find(
    (candidate) => candidate.stepKey === "concepts"
  );
  if (!step) {
    throw new ConceptError("Concepts wizard state is unavailable.");
  }
  if (step.lockedAt) {
    throw new WizardLockedError(
      "Concepts are locked for this project version."
    );
  }

  return { version, progress, step };
}

export async function initializeConceptSet(input: {
  userId: string;
  projectId: string;
}) {
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  return db.$transaction(
    async (tx) => {
      const brief = await latestLockedBrief(tx, input.projectId);
      if (!brief) {
        throw new ConceptError(
          "Create and lock the Creative Brief before developing concepts."
        );
      }
      if (brief.lifecycle !== VersionLifecycle.LOCKED) {
        throw new ConceptError(
          "Lock the current Creative Brief before developing concepts."
        );
      }

      const logical = await tx.conceptSet.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId },
        update: {}
      });

      const latest = await tx.conceptSetVersion.findFirst({
        where: { conceptSetId: logical.id },
        orderBy: { versionNumber: "desc" }
      });

      if (
        latest &&
        latest.lifecycle === VersionLifecycle.DRAFT &&
        latest.sourceCreativeBriefVersionId === brief.id
      ) {
        await syncWizardState(tx, {
          projectVersionId: projectVersion.id,
          conceptSetVersionId: latest.id
        });
        return serializeConceptSet(tx, latest.id);
      }

      const step = await tx.wizardStepState.findFirst({
        where: {
          wizardProgress: {
            projectVersionId: projectVersion.id
          },
          stepKey: "concepts"
        }
      });
      if (!step) {
        throw new ConceptError("Concepts wizard state is unavailable.");
      }
      if (step.lockedAt) {
        throw new WizardLockedError(
          "Concepts are locked for this project version."
        );
      }

      if (latest?.lifecycle === VersionLifecycle.DRAFT) {
        const active = await activeConceptJob(tx, latest.nodeId);
        if (active) {
          throw new ConceptError(
            "Wait for the active concept generation before rebasing onto a new Creative Brief."
          );
        }
        await tx.conceptSetVersion.update({
          where: { id: latest.id },
          data: { lifecycle: VersionLifecycle.SUPERSEDED }
        });
      }

      const node = await tx.domainVersionNode.create({
        data: { kind: DomainVersionKind.CONCEPT_SET }
      });
      const created = await tx.conceptSetVersion.create({
        data: {
          conceptSetId: logical.id,
          nodeId: node.id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          sourceCreativeBriefVersionId: brief.id,
          createdByUserId: input.userId
        }
      });

      await registerDependencyEdgeInTransaction(tx, {
        upstreamNodeId: brief.nodeId,
        downstreamNodeId: node.id,
        relation: DependencyRelation.REFERENCES,
        reason:
          "Concept development is governed by this exact locked Creative Brief."
      });

      await syncWizardState(tx, {
        projectVersionId: projectVersion.id,
        conceptSetVersionId: created.id
      });

      return serializeConceptSet(tx, created.id);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function queueConceptGeneration(input: {
  userId: string;
  projectId: string;
  conceptSetVersionId: string;
  expectedRevision: number;
  operation: "generate" | "revise" | "combine";
  count?: number;
  direction: string;
  parentConceptIds?: string[];
}) {
  const env = getEnvironment();
  const configured = getConfiguredTextProvider(env);
  const projectVersion = await ensureWizardProgress({
    userId: input.userId,
    projectId: input.projectId
  });

  const context = await db.project.findFirst({
    where: {
      id: input.projectId,
      ...projectEditorWhere(input.userId)
    },
    select: {
      workspaceId: true,
      conceptSet: {
        select: {
          versions: {
            where: { id: input.conceptSetVersionId },
            take: 1,
            include: {
              sourceCreativeBriefVersion: {
                select: {
                  id: true,
                  nodeId: true,
                  lifecycle: true
                }
              }
            }
          }
        }
      }
    }
  });
  if (!context) throw new ConceptError("Project not found.");
  const version = context.conceptSet?.versions[0];
  if (!version) throw new ConceptError("Concept set version not found.");
  if (version.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This concept set version is locked.");
  }
  if (version.revision !== input.expectedRevision) {
    throw new ConceptConflictError(
      "Concepts changed in another request. Reload before generating."
    );
  }
  if (
    version.sourceCreativeBriefVersion.lifecycle !==
    VersionLifecycle.LOCKED
  ) {
    throw new ConceptError(
      "The pinned Creative Brief must remain locked."
    );
  }

  const parentConceptIds = Array.from(
    new Set(input.parentConceptIds ?? [])
  );
  if (input.operation === "revise" && parentConceptIds.length !== 1) {
    throw new ConceptError(
      "Concept revision requires exactly one source concept."
    );
  }
  if (
    input.operation === "combine" &&
    (parentConceptIds.length < 2 || parentConceptIds.length > 4)
  ) {
    throw new ConceptError(
      "Concept combination requires two to four source concepts."
    );
  }
  if (input.operation === "generate" && parentConceptIds.length) {
    throw new ConceptError(
      "Initial concept generation does not accept parent concepts."
    );
  }

  if (parentConceptIds.length) {
    const parentCount = await db.conceptOption.count({
      where: {
        id: { in: parentConceptIds },
        conceptSetVersionId: version.id
      }
    });
    if (parentCount !== parentConceptIds.length) {
      throw new ConceptError(
        "Every parent concept must belong to this concept set version."
      );
    }
  }

  const count =
    input.operation === "generate"
      ? Math.max(2, Math.min(6, input.count ?? 4))
      : 1;

  const request = queuedConceptGenerationSchema.parse({
    textOperation: "concepts",
    projectId: input.projectId,
    projectVersionId: projectVersion.id,
    conceptSetVersionId: version.id,
    creativeBriefVersionId:
      version.sourceCreativeBriefVersion.id,
    operation: input.operation,
    count,
    direction: input.direction,
    parentConceptIds
  });

  const job = await enqueueGenerationJob({
    workspaceId: context.workspaceId,
    projectId: input.projectId,
    kind: GenerationKind.TEXT,
    providerKey: configured.provider.key,
    modelKey: configured.model,
    requestSnapshot: toJson(request),
    requestedByUserId: input.userId,
    inputs: [
      {
        nodeId: version.nodeId,
        role: "concept-set"
      },
      {
        nodeId: version.sourceCreativeBriefVersion.nodeId,
        role: "creative-brief"
      }
    ],
    prepare: async (tx, jobId) => {
      const current = await tx.conceptSetVersion.findUnique({
        where: { id: version.id }
      });
      if (
        !current ||
        current.lifecycle !== VersionLifecycle.DRAFT ||
        current.revision !== input.expectedRevision
      ) {
        throw new ConceptConflictError(
          "Concepts changed before the generation job could be queued."
        );
      }
      const active = await activeConceptJob(
        tx,
        version.nodeId,
        jobId
      );
      if (active) {
        throw new ConceptError(
          "Another concept-generation job is already active."
        );
      }

      await prepareAutomaticWizardStepInTransaction(tx, {
        projectVersionId: projectVersion.id,
        stepKey: "concepts",
        payload: toJson({
          conceptSetVersionId: version.id,
          operation: request.operation,
          activeJobId: jobId
        })
      });
    }
  });

  return {
    jobId: job.id,
    status: job.status,
    providerKey: job.providerKey,
    modelKey: job.modelKey
  };
}

export async function persistConceptGeneration(input: {
  generationJobId: string;
  request: QueuedConceptGeneration;
  concepts: ConceptContent[];
  requestedByUserId: string | null;
}) {
  return db.$transaction(
    async (tx) => {
      const existing = await tx.conceptOption.findMany({
        where: { generationJobId: input.generationJobId },
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true
        }
      });
      if (existing.length) {
        return {
          conceptSetVersionId: input.request.conceptSetVersionId,
          conceptIds: existing.map((item) => item.id),
          idempotent: true
        };
      }

      const version = await tx.conceptSetVersion.findUnique({
        where: { id: input.request.conceptSetVersionId },
        include: {
          sourceCreativeBriefVersion: {
            select: { id: true }
          }
        }
      });
      if (!version) {
        throw new ConceptError("Concept set version no longer exists.");
      }
      if (version.lifecycle !== VersionLifecycle.DRAFT) {
        throw new ConceptError(
          "Concept set is no longer editable; generated output was not attached."
        );
      }
      if (
        version.sourceCreativeBriefVersionId !==
        input.request.creativeBriefVersionId
      ) {
        throw new ConceptError(
          "Concept generation source brief no longer matches the concept set."
        );
      }

      const parentIds = input.request.parentConceptIds;
      const parents = parentIds.length
        ? await tx.conceptOption.findMany({
            where: {
              id: { in: parentIds },
              conceptSetVersionId: version.id
            },
            select: { id: true }
          })
        : [];
      if (parents.length !== parentIds.length) {
        throw new ConceptError(
          "One or more concept-generation parents no longer exist."
        );
      }

      const max = await tx.conceptOption.aggregate({
        where: { conceptSetVersionId: version.id },
        _max: { position: true }
      });
      let nextPosition = (max._max.position ?? -1) + 1;
      const createdIds: string[] = [];

      for (const concept of input.concepts) {
        const origin =
          input.request.operation === "generate"
            ? ConceptOptionOrigin.GENERATED
            : input.request.operation === "revise"
              ? ConceptOptionOrigin.REVISED
              : ConceptOptionOrigin.COMBINED;

        const created = await tx.conceptOption.create({
          data: {
            conceptSetVersionId: version.id,
            origin,
            position: nextPosition++,
            content: toJson(concept),
            generationJobId: input.generationJobId,
            revisionInstruction:
              input.request.operation === "generate"
                ? null
                : input.request.direction || null,
            createdByUserId: input.requestedByUserId
          }
        });
        createdIds.push(created.id);

        if (input.request.operation !== "generate") {
          await tx.conceptOptionLineage.createMany({
            data: parentIds.map((parentConceptId, index) => ({
              childConceptId: created.id,
              parentConceptId,
              role:
                input.request.operation === "revise"
                  ? ConceptLineageRole.REVISION_SOURCE
                  : ConceptLineageRole.COMBINATION_SOURCE,
              position: index
            }))
          });
        }
      }

      await tx.conceptSetVersion.update({
        where: { id: version.id },
        data: { revision: { increment: 1 } }
      });

      await tx.generationOutput.upsert({
        where: {
          jobId_role_position: {
            jobId: input.generationJobId,
            role: "concept-set",
            position: 0
          }
        },
        create: {
          jobId: input.generationJobId,
          nodeId: version.nodeId,
          role: "concept-set",
          position: 0
        },
        update: {
          nodeId: version.nodeId
        }
      });

      await syncWizardState(tx, {
        projectVersionId: input.request.projectVersionId,
        conceptSetVersionId: version.id
      });

      return {
        conceptSetVersionId: version.id,
        conceptIds: createdIds,
        idempotent: false
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function selectConcept(input: {
  userId: string;
  projectId: string;
  conceptSetVersionId: string;
  expectedRevision: number;
  conceptId: string;
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
      const option = await tx.conceptOption.findFirst({
        where: {
          id: input.conceptId,
          conceptSetVersionId: context.version.id
        }
      });
      if (!option) {
        throw new ConceptError(
          "Selected concept does not belong to this concept set."
        );
      }

      const changed = await tx.conceptSetVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision,
          lifecycle: VersionLifecycle.DRAFT
        },
        data: {
          selectedConceptId: option.id,
          revision: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new ConceptConflictError(
          "Concepts changed while selection was being saved."
        );
      }

      const wizard = await syncWizardState(tx, {
        projectVersionId: projectVersion.id,
        conceptSetVersionId: context.version.id
      });

      return {
        version: await serializeConceptSet(tx, context.version.id),
        impactWarnings: wizard.impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function completeConcepts(input: {
  userId: string;
  projectId: string;
  conceptSetVersionId: string;
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
      if (!context.version.selectedConceptId) {
        throw new ConceptError(
          "Select one concept before completing this stage."
        );
      }
      if (await activeConceptJob(tx, context.version.nodeId)) {
        throw new ConceptError(
          "Wait for active concept generation to finish before completing this stage."
        );
      }

      const changed = await tx.conceptSetVersion.updateMany({
        where: {
          id: context.version.id,
          revision: input.expectedRevision
        },
        data: {
          revision: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new ConceptConflictError(
          "Concepts changed while the stage was being completed."
        );
      }

      await refreshConceptSetFingerprint(tx, context.version.id);
      const wizard =
        await completeAutomaticWizardStepInTransaction(tx, {
          projectVersionId: projectVersion.id,
          stepKey: "concepts",
          payload: await wizardPayload(tx, context.version.id),
          semanticFingerprint:
            await selectedSemanticFingerprint(
              tx,
              context.version.id
            )
        });

      return {
        version: await serializeConceptSet(tx, context.version.id),
        impactWarnings: wizard.impactWarnings
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function reopenConcepts(input: {
  userId: string;
  projectId: string;
  conceptSetVersionId: string;
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
          version: await serializeConceptSet(tx, context.version.id),
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
          currentStepKey: "concepts"
        }
      });

      return {
        version: await serializeConceptSet(tx, context.version.id),
        impactWarnings: []
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function lockConcepts(input: {
  userId: string;
  projectId: string;
  conceptSetVersionId: string;
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
        throw new ConceptError(
          "Complete Concepts before locking them."
        );
      }
      if (!context.version.selectedConceptId) {
        throw new ConceptError(
          "Select a concept before locking this stage."
        );
      }
      if (await activeConceptJob(tx, context.version.nodeId)) {
        throw new ConceptError(
          "Wait for active concept generation to finish before locking this stage."
        );
      }

      const now = new Date();
      const changed = await tx.conceptSetVersion.updateMany({
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
        throw new ConceptConflictError(
          "Concepts changed while the stage was being locked."
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
      await refreshConceptSetFingerprint(tx, context.version.id);

      return {
        version: await serializeConceptSet(tx, context.version.id),
        impactWarnings: []
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function getConceptState(input: {
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
      creativeBrief: {
        select: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: {
              id: true,
              versionNumber: true,
              lifecycle: true
            }
          }
        }
      },
      conceptSet: {
        select: {
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: {
              id: true,
              nodeId: true,
              sourceCreativeBriefVersionId: true
            }
          }
        }
      }
    }
  });
  if (!project) throw new ConceptError("Project not found.");

  const latestBrief =
    project.creativeBrief?.versions[0] ?? null;
  const latestRef = project.conceptSet?.versions[0] ?? null;
  const latest = latestRef
    ? await serializeConceptSet(db, latestRef.id)
    : null;

  const recentJob = latestRef
    ? await recentConceptJob(db, latestRef.nodeId)
    : null;

  let providerAvailable = false;
  try {
    providerAvailable = textGenerationAvailable(getEnvironment());
  } catch {
    providerAvailable = false;
  }

  return {
    latestBrief,
    latest,
    recentJob,
    providerAvailable,
    sourceReady:
      Boolean(latestBrief) &&
      latestBrief!.lifecycle === VersionLifecycle.LOCKED,
    needsRebase:
      Boolean(latestBrief && latest) &&
      latestBrief!.id !== latest!.sourceCreativeBriefVersionId
  };
}
