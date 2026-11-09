import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEnvironment } from "@/lib/env";
import { createAssetStorage } from "@/lib/storage";
import { ensureWizardProgress, saveManagedWizardStepInTransaction } from "@/lib/wizard/service";
import { lockedShotSpecificationSources, initialFrameAssetsForProject, currentFrameVersions } from "@/lib/initial-frames/source";
import { completeInitialFramesIfCovered } from "@/lib/initial-frames/service";
import { completeVideoClipsIfCovered } from "@/lib/video-clips/service";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { MediaImportError, detectImportedMedia, probeImportedMedia } from "./probe";

type ImportInput = { userId: string; projectId: string; kind: "image" | "video"; shotSpecificationVersionId: string;
  expectedWizardRevision: number; bytes: Uint8Array; originalFileName: string };

async function context(tx: Prisma.TransactionClient, input: Omit<ImportInput, "bytes" | "originalFileName">, projectVersionId: string) {
  const progress = await tx.wizardProgress.findFirst({ where: { projectVersionId, projectVersion: {
    projectId: input.projectId, lifecycle: "DRAFT", project: { workspace: { memberships: { some: { userId: input.userId } } } }
  } }, include: { steps: true, projectVersion: { include: { project: true } } } });
  if (!progress) throw new MediaImportError("Project is unavailable for editing.", 404);
  if (progress.revision !== input.expectedWizardRevision) throw new MediaImportError("The project changed. Refresh before importing media.", 409);
  const stepKey = input.kind === "image" ? "initial-frames" : "video-clips";
  const step = progress.steps.find(item => item.stepKey === stepKey);
  if (!step || step.lockedAt) throw new MediaImportError("This media stage is locked.", 409);
  const sourceKey = input.kind === "image" ? "shot-specifications" : "initial-frames";
  if (!progress.steps.find(item => item.stepKey === sourceKey)?.lockedAt) throw new MediaImportError("Lock " + sourceKey.replaceAll("-", " ") + " before importing media.");
  const active = await tx.generationJob.count({ where: { projectId: input.projectId,
    providerKey: { contains: input.kind === "image" ? ":initial-frame" : ":video-clip" }, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active) throw new MediaImportError("Wait for the active media jobs to finish before importing.", 409);
  const sources = await lockedShotSpecificationSources(tx, projectVersionId);
  const source = sources.find(item => item.specificationVersion?.id === input.shotSpecificationVersionId);
  if (!source?.specification || source.specificationVersion?.lifecycle !== "LOCKED") throw new MediaImportError("Choose a current locked Shot Specification.");
  const frames = currentFrameVersions(sources, await initialFrameAssetsForProject(tx, input.projectId));
  const frame = frames.find(item => item.source.specificationVersion?.id === input.shotSpecificationVersionId)?.version;
  if (input.kind === "video" && (!frame || frame.status !== "READY")) throw new MediaImportError("A ready approved initial frame is required.");
  return { progress, step, stepKey, source, frame };
}

export async function importShotMedia(input: ImportInput) {
  const env = getEnvironment();
  if (!input.bytes.byteLength || input.bytes.byteLength > env.MAX_MEDIA_UPLOAD_BYTES) throw new MediaImportError("The media file is empty or exceeds the upload limit.", 413);
  const projectVersion = await ensureWizardProgress(input);
  await db.$transaction(tx => context(tx, input, projectVersion.id));
  const type = detectImportedMedia(input.bytes, input.kind);
  const directory = await mkdtemp(join(tmpdir(), "mvw-media-import-"));
  const path = join(directory, "upload." + type.extension);
  const storage = createAssetStorage();
  let storedKey: string | undefined;
  try {
    await writeFile(path, input.bytes, { flag: "wx" });
    const measured = await probeImportedMedia({ path, kind: input.kind, contentType: type.contentType,
      ffmpeg: env.VIDEO_RENDER_FFMPEG, ffprobe: env.VIDEO_RENDER_FFPROBE, signal: AbortSignal.timeout(60000) });
    const versionId = randomUUID();
    const nodeId = randomUUID();
    const checksum = createHash("sha256").update(input.bytes).digest("hex");
    const key = `workspaces/${projectVersion.project.workspaceId}/projects/${input.projectId}/imports/${versionId}.${type.extension}`;
    await storage.putFile({ key, filePath: path, contentType: type.contentType });
    storedKey = key;
    return await db.$transaction(async tx => {
      const current = await context(tx, input, projectVersion.id);
      const claimed = await tx.wizardProgress.updateMany({ where: { id: current.progress.id, revision: input.expectedWizardRevision }, data: { revision: { increment: 1 } } });
      if (claimed.count !== 1) throw new MediaImportError("The project changed. Refresh before importing media.", 409);
      const source = current.source.specificationVersion!;
      const editorialDurationMs = (current.source.storyboardVersion.plannedEndMs ?? 0) - (current.source.storyboardVersion.plannedStartMs ?? 0);
      if (input.kind === "video" && measured.durationMs! < editorialDurationMs) throw new MediaImportError("This clip is shorter than the shot's planned duration.");
      const role = input.kind === "image" ? "initial-frame" : "video-clip";
      const kind = input.kind === "image" ? "GENERATED_IMAGE" : "GENERATED_VIDEO";
      const assets = await tx.asset.findMany({ where: { projectId: input.projectId, kind }, include: { versions: { orderBy: { versionNumber: "desc" } } }, orderBy: { createdAt: "asc" } });
      const asset = assets.find(item => item.versions.some(version => (version.metadata as Record<string, unknown> | null)?.logicalShotId === source.shotId));
      const assetId = asset?.id ?? randomUUID();
      await tx.domainVersionNode.create({ data: { id: nodeId, kind: "ASSET", fingerprint: checksum } });
      if (!asset) await tx.asset.create({ data: { id: assetId, workspaceId: projectVersion.project.workspaceId, projectId: input.projectId, kind,
        name: (input.kind === "image" ? "Initial frame · " : "Video clip · ") + (source.label ?? "shot") } });
      await tx.assetVersion.create({ data: { id: versionId, assetId, nodeId, versionNumber: (asset?.versions[0]?.versionNumber ?? 0) + 1,
        status: "READY", storageKey: key, contentType: type.contentType, byteSize: BigInt(input.bytes.byteLength), checksumSha256: checksum,
        ...measured, metadata: { role, origin: "import", logicalShotId: source.shotId, sourceShotSpecificationVersionId: source.id,
          sourceStoryboardShotVersionId: current.source.storyboardVersion.id, generationJobId: null, providerId: "user-import", modelId: "uploaded-media",
          originalFileName: input.originalFileName.slice(0, 255),
          ...(input.kind === "video" ? { sourceInitialFrameAssetVersionId: current.frame!.id, editorialDurationMs, generatedDurationMs: measured.durationMs! } : {}) },
        createdByUserId: input.userId, readyAt: new Date() } });
      for (const upstreamNodeId of [source.nodeId, ...(input.kind === "video" ? [current.frame!.nodeId] : [])]) {
        await registerDependencyEdgeInTransaction(tx, { upstreamNodeId, downstreamNodeId: nodeId, relation: "REFERENCES", reason: "Imported media pins this exact approved creative source." });
      }
      // Invalidate affected downstream work while preserving its pinned historical assets.
      await saveManagedWizardStepInTransaction(tx, { projectVersionId: projectVersion.id, stepKey: current.stepKey,
        payload: { importedAssetVersionId: versionId }, semanticFingerprint: checksum });
      if (input.kind === "image") await completeInitialFramesIfCovered(tx, { projectId: input.projectId, projectVersionId: projectVersion.id });
      else await completeVideoClipsIfCovered(tx, { projectId: input.projectId, projectVersionId: projectVersion.id });
      return { assetVersionId: versionId, nodeId, checksumSha256: checksum, ...measured };
    }, { isolationLevel: "Serializable", timeout: 15000 });
  } catch (error) {
    if (storedKey) await storage.delete(storedKey).catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw new MediaImportError("The project changed. Refresh before importing media.", 409);
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
