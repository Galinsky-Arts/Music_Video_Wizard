import { randomUUID, createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createAssetStorage } from "@/lib/storage";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { ensureWizardProgress } from "@/lib/wizard/service";
import { narrativePlanSchema, type NarrativePlan } from "./plan";
export class NarrativeError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
const wherePlan = (projectId: string) => ({ asset: { projectId, kind: "OTHER" as const }, metadata: { path: ["role"], equals: "narrative-plan" } });
export async function getNarrativePlan(input: { userId: string; projectId: string }) {
  const project = await ensureWizardProgress(input);
  const latest = await db.assetVersion.findFirst({ where: wherePlan(input.projectId), orderBy: { createdAt: "desc" } });
  const metadata = latest?.metadata as Record<string, unknown> | null;
  const audio = project.audioMasterAssetVersionId ? await db.assetVersion.findUnique({ where: { id: project.audioMasterAssetVersionId } }) : null;
  return { versionId: latest?.id ?? null, versionNumber: latest?.versionNumber ?? 0, durationMs: audio?.durationMs ?? null,
    plan: metadata?.plan ? narrativePlanSchema.parse(metadata.plan) : null };
}
export async function saveNarrativePlan(input: { userId: string; projectId: string; expectedVersionId: string | null; plan: NarrativePlan }) {
  const project = await ensureWizardProgress(input), plan = narrativePlanSchema.parse(input.plan);
  const audio = project.audioMasterAssetVersionId ? await db.assetVersion.findUnique({ where: { id: project.audioMasterAssetVersionId } }) : null;
  if (!audio?.durationMs) throw new NarrativeError("Measure the original soundtrack before saving a timed narrative plan.");
  if (plan.durationMs !== audio.durationMs) throw new NarrativeError("Story timing must match the measured original soundtrack.");
  const bytes = Buffer.from(JSON.stringify(plan)), checksum = createHash("sha256").update(bytes).digest("hex");
  const id = randomUUID(), key = `workspaces/${project.project.workspaceId}/projects/${input.projectId}/narratives/${id}.json`;
  const storage = createAssetStorage(); await storage.put({ key, body: bytes, contentType: "application/json" });
  try {
    return await db.$transaction(async tx => {
      const access = await tx.project.findFirst({ where: { id: input.projectId, archivedAt: null, workspace: { memberships: { some: { userId: input.userId } } } } });
      if (!access) throw new NarrativeError("Project unavailable.", 404);
      const current = await tx.projectVersion.findUnique({ where: { id: project.id }, include: { audioMasterAssetVersion: true } });
      if (current?.audioMasterAssetVersionId !== audio.id || current.audioMasterAssetVersion?.durationMs !== plan.durationMs) throw new NarrativeError("The soundtrack changed. Reload before saving.", 409);
      const latest = await tx.assetVersion.findFirst({ where: wherePlan(input.projectId), orderBy: { createdAt: "desc" } });
      if ((latest?.id ?? null) !== input.expectedVersionId) throw new NarrativeError("The story was edited elsewhere. Reload before saving.", 409);
      const assetId = latest?.assetId ?? (await tx.asset.create({ data: { projectId: input.projectId, workspaceId: access.workspaceId, kind: "OTHER", name: "Narrative production plan" } })).id;
      const node = await tx.domainVersionNode.create({ data: { kind: "ASSET", fingerprint: checksum } });
      const version = await tx.assetVersion.create({ data: { id, assetId, nodeId: node.id,
        versionNumber: (latest?.versionNumber ?? 0) + 1, status: "READY", contentType: "application/json", storageKey: key, byteSize: bytes.length, checksumSha256: checksum,
        metadata: JSON.parse(JSON.stringify({ role: "narrative-plan", origin: "DIRECTOR_AUTHORED", sourceProjectVersionId: project.id, audioMasterAssetVersionId: audio.id, plan })),
        createdByUserId: input.userId, readyAt: new Date() } });
      for (const upstreamNodeId of [audio.nodeId, project.nodeId]) await registerDependencyEdgeInTransaction(tx, { upstreamNodeId, downstreamNodeId: node.id, relation: "REFERENCES", reason: "Narrative timing and continuity pin this exact project and soundtrack." });
      return { versionId: version.id, versionNumber: version.versionNumber };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    await storage.delete(key).catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw new NarrativeError("The story changed. Reload before saving.", 409);
    throw error;
  }
}
