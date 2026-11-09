import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEnvironment } from "@/lib/env";
import { ensureWizardProgress, completeAutomaticWizardStepInTransaction } from "@/lib/wizard/service";
import { createAssetStorage } from "@/lib/storage";
import { runMediaProcess } from "@/lib/media/process";
import { MediaImportError, detectImportedMedia, probeImportedMedia } from "@/lib/media-imports/probe";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { initializeWorkingTimeline } from "@/lib/refinement/service";

async function requireFreshProject(tx: Prisma.TransactionClient, projectVersionId: string, revision: number, userId: string) {
  const progress = await tx.wizardProgress.findFirst({ where: { projectVersionId, projectVersion: { project: {
    archivedAt: null, workspace: { memberships: { some: { userId } } }
  } } }, include: { steps: true, projectVersion: true } });
  if (!progress) throw new MediaImportError("Project unavailable.", 404);
  if (progress.revision !== revision) throw new MediaImportError("The project changed. Refresh before importing the edit.", 409);
  if (progress.projectVersion.lifecycle !== "DRAFT" || progress.steps.some(step => step.lockedAt && ["first-cut", "refinement", "finish-export"].includes(step.stepKey)) ||
      await tx.timeline.count({ where: { projectId: progress.projectVersion.projectId } })) {
    throw new MediaImportError("Import an assembly into a project that does not already have an edit. Existing edits are preserved.", 409);
  }
  if (await tx.generationJob.count({ where: { projectId: progress.projectVersion.projectId, status: { in: ["QUEUED", "RUNNING"] } } })) {
    throw new MediaImportError("Wait for the project's current jobs to finish before importing an assembly.", 409);
  }
  return progress;
}

/** Import a director-supplied visual edit; optional planning steps stay untouched. */
export async function importVisualAssembly(input: { userId: string; projectId: string; expectedWizardRevision: number;
  height: 720 | 1080; bytes: Uint8Array; originalFileName: string }) {
  const env = getEnvironment();
  const project = await ensureWizardProgress(input);
  await db.$transaction(tx => requireFreshProject(tx, project.id, input.expectedWizardRevision, input.userId));
  if (!input.bytes.byteLength || input.bytes.byteLength > env.MAX_MEDIA_UPLOAD_BYTES) throw new MediaImportError("The visual edit is empty or exceeds the upload limit.", 413);
  if (!project.audioMasterAssetVersionId) throw new MediaImportError("Upload the finished music before importing a visual edit.");
  const audio = await db.assetVersion.findFirst({ where: { id: project.audioMasterAssetVersionId, status: "READY", asset: { projectId: input.projectId, kind: "AUDIO_MASTER" } } });
  if (!audio) throw new MediaImportError("The original soundtrack is unavailable.");
  const type = detectImportedMedia(input.bytes, "video");
  const directory = await mkdtemp(join(tmpdir(), "mvw-assembly-"));
  const storage = createAssetStorage();
  let key: string | undefined;
  try {
    const path = join(directory, "visual." + type.extension);
    await writeFile(path, input.bytes);
    const signal = AbortSignal.timeout(120000);
    const measured = await probeImportedMedia({ path, kind: "video", contentType: type.contentType,
      ffmpeg: env.VIDEO_RENDER_FFMPEG, ffprobe: env.VIDEO_RENDER_FFPROBE, signal });
    // Count decoded soundtrack samples instead of treating MP3 encoder padding as music.
    const audioPath = join(directory, "master.audio");
    const pcmPath = join(directory, "duration.f32");
    await storage.downloadToFile(audio.storageKey, audioPath);
    await runMediaProcess({ executable: env.VIDEO_RENDER_FFMPEG,
      args: ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", audioPath, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-y", pcmPath],
      signal, description: "Immutable soundtrack duration measurement" });
    const durationMs = Math.round((await stat(pcmPath)).size / 4 / 48000 * 1000);
    if (durationMs <= 0 || measured.durationMs! < durationMs) throw new MediaImportError("The visual edit must cover the complete soundtrack. Its original audio will remain the soundtrack.");
    const versionId = randomUUID(), nodeId = randomUUID();
    const checksum = createHash("sha256").update(input.bytes).digest("hex");
    key = `workspaces/${project.project.workspaceId}/projects/${input.projectId}/assemblies/${versionId}.${type.extension}`;
    await storage.putFile({ key, filePath: path, contentType: type.contentType });
    const storageKey = key;
    return await db.$transaction(async tx => {
      const progress = await requireFreshProject(tx, project.id, input.expectedWizardRevision, input.userId);
      const claimed = await tx.wizardProgress.updateMany({ where: { id: progress.id, revision: input.expectedWizardRevision }, data: { revision: { increment: 1 } } });
      if (claimed.count !== 1) throw new MediaImportError("The project changed. Refresh before importing the edit.", 409);
      const ratio = (project.outputWidth ?? 1920) / (project.outputHeight ?? 1080);
      const width = Math.round(input.height * ratio / 2) * 2;
      await tx.projectVersion.update({ where: { id: project.id }, data: { outputWidth: width, outputHeight: input.height } });
      await tx.assetVersion.update({ where: { id: audio.id }, data: { durationMs } });
      const asset = await tx.asset.create({ data: { workspaceId: project.project.workspaceId, projectId: input.projectId, kind: "GENERATED_VIDEO", name: "Imported visual assembly" } });
      await tx.domainVersionNode.create({ data: { id: nodeId, kind: "ASSET", fingerprint: checksum } });
      await tx.assetVersion.create({ data: { id: versionId, assetId: asset.id, nodeId, versionNumber: 1, status: "READY", storageKey,
        contentType: type.contentType, byteSize: BigInt(input.bytes.byteLength), checksumSha256: checksum, ...measured,
        metadata: { role: "imported-assembly", origin: "import", originalFileName: input.originalFileName.slice(0, 255), generationJobId: null },
        createdByUserId: input.userId, readyAt: new Date() } });
      const shot = await tx.shot.create({ data: { projectId: input.projectId } });
      const shotNode = await tx.domainVersionNode.create({ data: { kind: "SHOT" } });
      const shotVersion = await tx.shotVersion.create({ data: { shotId: shot.id, nodeId: shotNode.id, versionNumber: 1, lifecycle: "LOCKED", lockedAt: new Date(),
        label: "Director's imported visual edit", plannedStartMs: 0, plannedEndMs: durationMs,
        structuredSpec: { origin: "IMPORTED_ASSEMBLY", sourceAssetVersionId: versionId }, createdByUserId: input.userId } });
      const timeline = await tx.timeline.create({ data: { projectId: input.projectId, kind: "FIRST_CUT", name: "Imported assembly" } });
      const timelineNode = await tx.domainVersionNode.create({ data: { kind: "TIMELINE" } });
      const first = await tx.timelineVersion.create({ data: { timelineId: timeline.id, nodeId: timelineNode.id, versionNumber: 1, lifecycle: "LOCKED", lockedAt: new Date(),
        basisProjectVersionId: project.id, audioMasterAssetVersionId: audio.id, compiledAutomatically: false,
        notes: "Imported director-supplied assembly. No planning or provider generation is claimed.", createdByUserId: input.userId,
        items: { create: { trackKind: "VIDEO", position: 0, origin: "MANUAL", shotVersionId: shotVersion.id, assetVersionId: versionId,
          timelineStartMs: 0, timelineEndMs: durationMs, sourceStartMs: 0, sourceEndMs: durationMs, parameters: { label: "Imported visual assembly" } } } },
        include: { node: true, items: { include: { assetVersion: true } }, transitions: true } });
      for (const upstreamNodeId of [nodeId, audio.nodeId]) await registerDependencyEdgeInTransaction(tx, { upstreamNodeId, downstreamNodeId: timelineNode.id, relation: "REFERENCES", reason: "Imported edit pins this exact media version." });
      await completeAutomaticWizardStepInTransaction(tx, { projectVersionId: project.id, stepKey: "first-cut",
        payload: { origin: "IMPORTED_ASSEMBLY", timelineVersionId: first.id, importedAssetVersionId: versionId, durationMs } });
      await tx.wizardStepState.updateMany({ where: { wizardProgressId: progress.id, stepKey: "first-cut" }, data: { lockedAt: new Date() } });
      const working = await initializeWorkingTimeline(tx, { projectId: input.projectId, projectVersionId: project.id, userId: input.userId, sourceFirstCut: first });
      return { assetVersionId: versionId, timelineVersionId: working.version.id, durationMs, width, height: input.height };
    }, { isolationLevel: "Serializable", timeout: 20000 });
  } catch (error) {
    if (key) await storage.delete(key).catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw new MediaImportError("The project changed. Refresh before importing the edit.", 409);
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
