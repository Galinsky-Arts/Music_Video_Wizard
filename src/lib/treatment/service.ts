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
import { enqueueGenerationJob } from "@/lib/jobs/service";
import { getConfiguredTextProvider, textGenerationAvailable } from "@/lib/text-generation/factory";
import { getEnvironment } from "@/lib/env";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import { conceptContentSchema } from "@/lib/concepts/schema";
import { creativeBriefDraftSchema } from "@/lib/creative-brief/input";
import {
  EMPTY_TREATMENT,
  treatmentCompletionIssues,
  treatmentDocumentSchema,
  treatmentDraftSchema,
  type TreatmentDraft
} from "./schema";
import { queuedTreatmentGenerationSchema } from "./input";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class TreatmentError extends Error {}
export class TreatmentConflictError extends TreatmentError {}

type Tx = Prisma.TransactionClient;
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function latestLockedConcept(tx: Tx, projectId: string) {
  return tx.conceptSetVersion.findFirst({
    where: {
      conceptSet: { projectId },
      lifecycle: VersionLifecycle.LOCKED,
      selectedConceptId: { not: null }
    },
    orderBy: { versionNumber: "desc" },
    include: {
      conceptSet: { include: { project: { include: { workspace: true } } } },
      selectedConcept: true,
      sourceCreativeBriefVersion: {
        include: {
          sourceMusicMapVersion: {
            include: {
              anchors: {
                where: { decision: "ACCEPTED" },
                orderBy: [{ startMs: "asc" }, { position: "asc" }]
              }
            }
          }
        }
      }
    }
  });
}

function semanticFingerprint(input: {
  sourceConceptSetVersionId: string;
  sourceConceptId: string;
  treatment: TreatmentDraft;
}) {
  return fingerprintJson(toJson(input) as unknown as Prisma.JsonValue);
}

async function refreshFingerprint(tx: Tx, treatmentVersionId: string) {
  const version = await tx.treatmentVersion.findUniqueOrThrow({
    where: { id: treatmentVersionId }
  });
  const treatment = treatmentDraftSchema.parse(version.document);
  const fingerprint = semanticFingerprint({
    sourceConceptSetVersionId: version.sourceConceptSetVersionId,
    sourceConceptId: version.sourceConceptId,
    treatment
  });
  await tx.domainVersionNode.update({
    where: { id: version.nodeId },
    data: { fingerprint }
  });
  return { fingerprint, treatment, nodeId: version.nodeId };
}

async function wizardPayload(tx: Tx, treatmentVersionId: string) {
  const version = await tx.treatmentVersion.findUniqueOrThrow({
    where: { id: treatmentVersionId },
    include: {
      sourceConcept: true,
      sourceConceptSetVersion: true
    }
  });
  const treatment = treatmentDraftSchema.parse(version.document);
  return toJson({
    treatmentVersionId: version.id,
    treatmentNodeId: version.nodeId,
    treatmentRevision: version.revision,
    sourceConceptSetVersionId: version.sourceConceptSetVersionId,
    sourceConceptSetVersionNumber: version.sourceConceptSetVersion.versionNumber,
    sourceConceptId: version.sourceConceptId,
    sourceConceptTitle: conceptContentSchema.parse(version.sourceConcept.content).title,
    sectionCount: treatment.sections.length
  });
}

async function syncWizard(tx: Tx, projectVersionId: string, treatmentVersionId: string) {
  const refreshed = await refreshFingerprint(tx, treatmentVersionId);
  const wizard = await saveManagedWizardStepInTransaction(tx, {
    projectVersionId,
    stepKey: "treatment",
    payload: await wizardPayload(tx, treatmentVersionId),
    semanticFingerprint: refreshed.fingerprint
  });
  return { ...refreshed, wizard };
}

async function serializeTreatment(tx: Tx, treatmentVersionId: string) {
  const version = await tx.treatmentVersion.findUniqueOrThrow({
    where: { id: treatmentVersionId },
    include: {
      sourceConcept: true,
      sourceConceptSetVersion: {
        include: {
          sourceCreativeBriefVersion: {
            include: {
              sourceMusicMapVersion: {
                include: {
                  anchors: {
                    where: { decision: "ACCEPTED" },
                    orderBy: [{ startMs: "asc" }, { position: "asc" }]
                  }
                }
              }
            }
          }
        }
      }
    }
  });
  const source = version.sourceConceptSetVersion;
  return {
    id: version.id,
    nodeId: version.nodeId,
    versionNumber: version.versionNumber,
    lifecycle: version.lifecycle,
    revision: version.revision,
    sourceConceptSetVersionId: version.sourceConceptSetVersionId,
    sourceConceptSetVersionNumber: source.versionNumber,
    sourceConceptId: version.sourceConceptId,
    selectedConcept: conceptContentSchema.parse(version.sourceConcept.content),
    creativeBrief: creativeBriefDraftSchema.parse(source.sourceCreativeBriefVersion.brief),
    musicMap: {
      durationMs: source.sourceCreativeBriefVersion.sourceMusicMapVersion.durationMs,
      anchors: source.sourceCreativeBriefVersion.sourceMusicMapVersion.anchors.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        startMs: a.startMs,
        endMs: a.endMs
      }))
    },
    treatment: treatmentDraftSchema.parse(version.document),
    generationJobId: version.generationJobId,
    createdAt: version.createdAt,
    lockedAt: version.lockedAt
  };
}

async function mutationContext(tx: Tx, input: {
  userId: string;
  projectId: string;
  projectVersionId: string;
  treatmentVersionId: string;
  expectedRevision: number;
}) {
  const version = await tx.treatmentVersion.findFirst({
    where: {
      id: input.treatmentVersionId,
      treatment: {
        projectId: input.projectId,
        project: {
          ...projectEditorWhere(input.userId)
        }
      }
    }
  });
  if (!version) throw new TreatmentError("Treatment version not found.");
  if (version.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This Treatment version is locked.");
  }
  if (version.revision !== input.expectedRevision) {
    throw new TreatmentConflictError("Treatment changed in another request. Reload before continuing.");
  }
  const progress = await tx.wizardProgress.findFirst({
    where: { projectVersionId: input.projectVersionId },
    include: { projectVersion: true, steps: true }
  });
  if (!progress || progress.projectVersion.projectId !== input.projectId) {
    throw new TreatmentError("Wizard progress not found.");
  }
  if (progress.projectVersion.lifecycle !== VersionLifecycle.DRAFT) {
    throw new WizardLockedError("This project version is locked.");
  }
  const step = progress.steps.find((item) => item.stepKey === "treatment");
  if (!step) throw new TreatmentError("Treatment wizard state is unavailable.");
  if (step.lockedAt) throw new WizardLockedError("Treatment is locked for this project version.");
  return { version, progress, step };
}

async function activeTreatmentJob(tx: Tx, nodeId: string) {
  return tx.generationJob.findFirst({
    where: {
      kind: GenerationKind.TEXT,
      status: { in: [GenerationStatus.QUEUED, GenerationStatus.RUNNING] },
      inputs: { some: { nodeId, role: "treatment" } }
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function initializeTreatment(input: { userId: string; projectId: string }) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(async (tx) => {
    const source = await latestLockedConcept(tx, input.projectId);
    if (!source || !source.selectedConcept) {
      throw new TreatmentError("Select, complete, and lock a concept before starting Treatment.");
    }
    const logical = await tx.treatment.upsert({
      where: { projectId: input.projectId },
      create: { projectId: input.projectId },
      update: {}
    });
    const latest = await tx.treatmentVersion.findFirst({
      where: { treatmentId: logical.id },
      orderBy: { versionNumber: "desc" }
    });
    if (
      latest &&
      latest.lifecycle === VersionLifecycle.DRAFT &&
      latest.sourceConceptSetVersionId === source.id &&
      latest.sourceConceptId === source.selectedConcept.id
    ) {
      await syncWizard(tx, projectVersion.id, latest.id);
      return serializeTreatment(tx, latest.id);
    }
    if (latest?.lifecycle === VersionLifecycle.DRAFT) {
      await tx.treatmentVersion.update({
        where: { id: latest.id },
        data: { lifecycle: VersionLifecycle.SUPERSEDED }
      });
    }
    const node = await tx.domainVersionNode.create({
      data: { kind: DomainVersionKind.TREATMENT }
    });
    const created = await tx.treatmentVersion.create({
      data: {
        treatmentId: logical.id,
        nodeId: node.id,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        sourceConceptSetVersionId: source.id,
        sourceConceptId: source.selectedConcept.id,
        document: toJson(EMPTY_TREATMENT),
        createdByUserId: input.userId
      }
    });
    await registerDependencyEdgeInTransaction(tx, {
      upstreamNodeId: source.nodeId,
      downstreamNodeId: node.id,
      relation: DependencyRelation.REFERENCES,
      reason: "Treatment expands this exact locked selected concept."
    });
    await syncWizard(tx, projectVersion.id, created.id);
    return serializeTreatment(tx, created.id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function saveTreatment(input: {
  userId: string; projectId: string; treatmentVersionId: string;
  expectedRevision: number; treatment: TreatmentDraft;
}) {
  const projectVersion = await ensureWizardProgress(input);
  const treatment = treatmentDraftSchema.parse(input.treatment);
  return db.$transaction(async (tx) => {
    const context = await mutationContext(tx, { ...input, projectVersionId: projectVersion.id });
    if (await activeTreatmentJob(tx, context.version.nodeId)) {
      throw new TreatmentError("Wait for treatment generation to finish before editing.");
    }
    const changed = await tx.treatmentVersion.updateMany({
      where: { id: context.version.id, revision: input.expectedRevision, lifecycle: VersionLifecycle.DRAFT },
      data: { document: toJson(treatment), revision: { increment: 1 } }
    });
    if (changed.count !== 1) throw new TreatmentConflictError("Treatment changed while saving.");
    const synced = await syncWizard(tx, projectVersion.id, context.version.id);
    return {
      version: await serializeTreatment(tx, context.version.id),
      impactWarnings: synced.wizard.impactWarnings
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function queueTreatmentGeneration(input: {
  userId: string; projectId: string; treatmentVersionId: string;
  expectedRevision: number; direction: string;
}) {
  const projectVersion = await ensureWizardProgress(input);
  const env = getEnvironment();
  const configured = getConfiguredTextProvider(env);
  const context = await db.$transaction(async (tx) => {
    const current = await mutationContext(tx, { ...input, projectVersionId: projectVersion.id });
    if (await activeTreatmentJob(tx, current.version.nodeId)) {
      throw new TreatmentError("A treatment generation job is already active.");
    }
    const source = await tx.conceptSetVersion.findUniqueOrThrow({
      where: { id: current.version.sourceConceptSetVersionId }
    });
    return {
      nodeId: current.version.nodeId,
      sourceNodeId: source.nodeId,
      sourceConceptSetVersionId: current.version.sourceConceptSetVersionId,
      sourceConceptId: current.version.sourceConceptId
    };
  });
  const request = queuedTreatmentGenerationSchema.parse({
    textOperation: "treatment",
    projectId: input.projectId,
    projectVersionId: projectVersion.id,
    treatmentVersionId: input.treatmentVersionId,
    conceptSetVersionId: context.sourceConceptSetVersionId,
    conceptId: context.sourceConceptId,
    direction: input.direction
  });
  const workspace = await db.project.findUniqueOrThrow({
    where: { id: input.projectId },
    select: { workspaceId: true }
  });
  const job = await enqueueGenerationJob({
    workspaceId: workspace.workspaceId,
    projectId: input.projectId,
    kind: GenerationKind.TEXT,
    providerKey: configured.provider.key + ":treatment",
    modelKey: configured.model,
    requestSnapshot: toJson(request),
    requestedByUserId: input.userId,
    inputs: [
      { nodeId: context.sourceNodeId, role: "selected-concept" },
      { nodeId: context.nodeId, role: "treatment" }
    ],
    prepare: async (tx, jobId) => {
      await tx.treatmentVersion.update({
        where: { id: input.treatmentVersionId },
        data: { generationJobId: jobId }
      });
    }
  });
  return { jobId: job.id, status: job.status };
}

export async function persistTreatmentGeneration(input: {
  generationJobId: string;
  treatmentVersionId: string;
  conceptSetVersionId: string;
  conceptId: string;
  treatment: unknown;
}) {
  const treatment = treatmentDocumentSchema.parse(input.treatment);
  return db.$transaction(async (tx) => {
    const version = await tx.treatmentVersion.findUniqueOrThrow({
      where: { id: input.treatmentVersionId }
    });
    if (
      version.sourceConceptSetVersionId !== input.conceptSetVersionId ||
      version.sourceConceptId !== input.conceptId ||
      version.generationJobId !== input.generationJobId ||
      version.lifecycle !== VersionLifecycle.DRAFT
    ) {
      throw new TreatmentError("Treatment generation no longer matches the pinned source.");
    }
    const existing = await tx.generationOutput.findFirst({
      where: { jobId: input.generationJobId, role: "treatment" }
    });
    if (existing) return { treatmentVersionId: version.id, nodeId: version.nodeId };
    await tx.treatmentVersion.update({
      where: { id: version.id },
      data: { document: toJson(treatment), revision: { increment: 1 } }
    });
    await tx.generationOutput.create({
      data: { jobId: input.generationJobId, nodeId: version.nodeId, role: "treatment" }
    });
    await syncWizard(tx, queuedTreatmentGenerationSchema.parse(
      (await tx.generationJob.findUniqueOrThrow({ where: { id: input.generationJobId } })).requestSnapshot
    ).projectVersionId, version.id);
    return { treatmentVersionId: version.id, nodeId: version.nodeId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function completeTreatment(input: {
  userId: string; projectId: string; treatmentVersionId: string; expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(async (tx) => {
    const context = await mutationContext(tx, { ...input, projectVersionId: projectVersion.id });
    if (await activeTreatmentJob(tx, context.version.nodeId)) {
      throw new TreatmentError("Wait for treatment generation to finish before completing Treatment.");
    }
    const draft = treatmentDraftSchema.parse(context.version.document);
    const source = await tx.conceptSetVersion.findUniqueOrThrow({
      where: { id: context.version.sourceConceptSetVersionId },
      include: {
        sourceCreativeBriefVersion: {
          include: { sourceMusicMapVersion: true }
        }
      }
    });
    const issues = treatmentCompletionIssues(
      draft,
      source.sourceCreativeBriefVersion.sourceMusicMapVersion.durationMs
    );
    if (issues.length) throw new TreatmentError(issues.join(" "));
    const changed = await tx.treatmentVersion.updateMany({
      where: { id: context.version.id, revision: input.expectedRevision },
      data: { revision: { increment: 1 } }
    });
    if (changed.count !== 1) throw new TreatmentConflictError("Treatment changed while completing.");
    const refreshed = await refreshFingerprint(tx, context.version.id);
    const wizard = await completeAutomaticWizardStepInTransaction(tx, {
      projectVersionId: projectVersion.id,
      stepKey: "treatment",
      payload: await wizardPayload(tx, context.version.id),
      semanticFingerprint: refreshed.fingerprint
    });
    return { version: await serializeTreatment(tx, context.version.id), impactWarnings: wizard.impactWarnings };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function reopenTreatment(input: {
  userId: string; projectId: string; treatmentVersionId: string; expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(async (tx) => {
    const context = await mutationContext(tx, { ...input, projectVersionId: projectVersion.id });
    if (context.step.status !== WizardStepStatus.COMPLETED) {
      return { version: await serializeTreatment(tx, context.version.id), impactWarnings: [] };
    }
    await tx.wizardStepState.update({
      where: { id: context.step.id },
      data: { status: WizardStepStatus.IN_PROGRESS, completedAt: null, needsReviewAt: null, reviewReason: null }
    });
    await tx.wizardProgress.update({
      where: { id: context.progress.id },
      data: { revision: { increment: 1 }, currentStepKey: "treatment" }
    });
    return { version: await serializeTreatment(tx, context.version.id), impactWarnings: [] };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function lockTreatment(input: {
  userId: string; projectId: string; treatmentVersionId: string; expectedRevision: number;
}) {
  const projectVersion = await ensureWizardProgress(input);
  return db.$transaction(async (tx) => {
    const context = await mutationContext(tx, { ...input, projectVersionId: projectVersion.id });
    if (context.step.status !== WizardStepStatus.COMPLETED) {
      throw new TreatmentError("Complete Treatment before locking it.");
    }
    const now = new Date();
    const changed = await tx.treatmentVersion.updateMany({
      where: { id: context.version.id, revision: input.expectedRevision, lifecycle: VersionLifecycle.DRAFT },
      data: { lifecycle: VersionLifecycle.LOCKED, revision: { increment: 1 }, lockedAt: now }
    });
    if (changed.count !== 1) throw new TreatmentConflictError("Treatment changed while locking.");
    await tx.wizardStepState.update({ where: { id: context.step.id }, data: { lockedAt: now } });
    await tx.wizardProgress.update({ where: { id: context.progress.id }, data: { revision: { increment: 1 } } });
    await refreshFingerprint(tx, context.version.id);
    return { version: await serializeTreatment(tx, context.version.id), impactWarnings: [] };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function getTreatmentState(input: { userId: string; projectId: string }) {
  const project = await db.project.findFirst({
    where: {
      id: input.projectId,
      ...projectEditorWhere(input.userId)
    },
    include: {
      conceptSet: { include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } } },
      treatment: { include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } } }
    }
  });
  if (!project) throw new TreatmentError("Project not found.");
  const latestConcept = project.conceptSet?.versions[0] ?? null;
  const latestRef = project.treatment?.versions[0] ?? null;
  const latest = latestRef ? await serializeTreatment(db, latestRef.id) : null;
  const recentJob = latestRef
    ? await db.generationJob.findFirst({
        where: { inputs: { some: { nodeId: latestRef.nodeId, role: "treatment" } } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, progressPercent: true, progressMessage: true, errorMessage: true, createdAt: true }
      })
    : null;
  let providerAvailable = false;
  try { providerAvailable = textGenerationAvailable(getEnvironment()); } catch {}
  return {
    latest,
    latestConcept,
    recentJob,
    providerAvailable,
    sourceReady: Boolean(latestConcept && latestConcept.lifecycle === VersionLifecycle.LOCKED && latestConcept.selectedConceptId),
    needsRebase: Boolean(latestConcept && latest && (
      latestConcept.id !== latest.sourceConceptSetVersionId ||
      latestConcept.selectedConceptId !== latest.sourceConceptId
    ))
  };
}
