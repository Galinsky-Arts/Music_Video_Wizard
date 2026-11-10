// Synthetic media and persisted pre-render state only. This does not claim live-provider acceptance.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../src/lib/db";
import { createProjectWithAudio } from "../../src/lib/projects/create-project";
import { ensureWizardProgress } from "../../src/lib/wizard/service";
import { createAssetStorage } from "../../src/lib/storage";
import { runMediaProcess } from "../../src/lib/media/process";

export async function createRenderFixture(userId: string, fresh = false, durationSeconds = 3) {
  const directory = await mkdtemp(join(tmpdir(), "mvw-browser-render-"));
  const ffmpeg = process.env.VIDEO_RENDER_FFMPEG ?? "ffmpeg";
  const signal = AbortSignal.timeout(60_000);
  const run = (args: string[]) => runMediaProcess({ executable: ffmpeg, args, signal, description: "Synthetic browser fixture" });
  const storage = createAssetStorage();
  const keys: string[] = [];
  let projectId: string | undefined;
  let workspaceId: string | undefined;
  const cleanup = async () => {
    if (projectId) {
      const nodes = [
        ...await db.projectVersion.findMany({ where: { projectId }, select: { nodeId: true } }),
        ...await db.assetVersion.findMany({ where: { asset: { projectId } }, select: { nodeId: true, storageKey: true } }),
        ...await db.shotVersion.findMany({ where: { shot: { projectId } }, select: { nodeId: true } }),
        ...await db.timelineVersion.findMany({ where: { timeline: { projectId } }, select: { nodeId: true } }),
        ...await db.sequenceVersion.findMany({ where: { sequence: { projectId } }, select: { nodeId: true } })
      ];
      const assets = await db.assetVersion.findMany({ where: { asset: { projectId } } });
      for (const asset of assets) await storage.delete(asset.storageKey);
      await db.generationJob.deleteMany({ where: { projectId } });
      await db.timelineVersion.deleteMany({ where: { timeline: { projectId } } });
      await db.timeline.deleteMany({ where: { projectId } });
      await db.sequenceVersionShot.deleteMany({ where: { sequenceVersion: { sequence: { projectId } } } });
      await db.projectVersionSequence.deleteMany({ where: { projectVersionId: { in: (await db.projectVersion.findMany({ where: { projectId }, select: { id: true } })).map(item => item.id) } } });
      await db.sequenceVersion.deleteMany({ where: { sequence: { projectId } } });
      await db.sequence.deleteMany({ where: { projectId } });
      await db.shotVersion.deleteMany({ where: { shot: { projectId } } });
      await db.shot.deleteMany({ where: { projectId } });
      await db.projectVersion.deleteMany({ where: { projectId } });
      await db.assetVersion.deleteMany({ where: { asset: { projectId } } });
      await db.asset.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      const ids = nodes.map(node => node.nodeId);
      await db.dependencyEdge.deleteMany({ where: { OR: [{ upstreamNodeId: { in: ids } }, { downstreamNodeId: { in: ids } }] } });
      await db.domainVersionNode.deleteMany({ where: { id: { in: ids } } });
    }
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
    for (const key of keys) await storage.delete(key);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const audioPath = join(directory, "tone.wav");
    await run(["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}`, "-y", audioPath]);
    const created = await createProjectWithAudio({ userId, displayName: "Render acceptance",
      project: { title: "Synthetic final delivery", description: "Browser-to-FFmpeg acceptance fixture", aspectRatio: "16:9", frameRate: 24 },
      audio: { originalFileName: "tone.wav", bytes: await readFile(audioPath) } });
    projectId = created.projectId;
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    workspaceId = project.workspaceId;
    await db.projectVersion.update({ where: { id: created.projectVersionId }, data: { outputWidth: 160, outputHeight: 90 } });
    await db.assetVersion.update({ where: { id: created.audioAssetVersionId }, data: { durationMs: durationSeconds * 1000 } });
    await ensureWizardProgress({ userId, projectId });
    if (fresh) return { ...created, cleanup };
    const timeline = await db.timeline.create({ data: { projectId, name: "Synthetic locked refinement", kind: "WORKING" } });
    const node = await db.domainVersionNode.create({ data: { kind: "TIMELINE" } });
    const version = await db.timelineVersion.create({ data: { timelineId: timeline.id, nodeId: node.id, versionNumber: 1,
      lifecycle: "LOCKED", lockedAt: new Date(), basisProjectVersionId: created.projectVersionId, audioMasterAssetVersionId: created.audioAssetVersionId } });
    const itemIds: string[] = [];
    for (const [position, color] of ["red", "green", "blue"].entries()) {
      const clipPath = join(directory, position + ".mp4");
      await run(["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=24:d=2`, "-y", clipPath]);
      const key = `test-fixtures/${projectId}/${randomUUID()}.mp4`;
      keys.push(key);
      await storage.putFile({ key, filePath: clipPath, contentType: "video/mp4" });
      const clip = await db.asset.create({ data: { workspaceId, projectId, kind: "GENERATED_VIDEO", name: `Synthetic ${color}`,
        versions: { create: { versionNumber: 1, node: { create: { kind: "ASSET" } }, status: "READY", storageKey: key,
          contentType: "video/mp4", durationMs: 2000 } } }, include: { versions: true } });
      const shot = await db.shot.create({ data: { projectId,
        versions: { create: { versionNumber: 1, node: { create: { kind: "SHOT" } }, lifecycle: "LOCKED", label: color } } }, include: { versions: true } });
      const item = await db.timelineItem.create({ data: { timelineVersionId: version.id, trackKind: "VIDEO", position,
        shotVersionId: shot.versions[0]!.id, assetVersionId: clip.versions[0]!.id,
        timelineStartMs: position * 1000, timelineEndMs: (position + 1) * 1000, sourceStartMs: 200, sourceEndMs: 1200 } });
      itemIds.push(item.id);
    }
    await db.timelineTransition.create({ data: { timelineVersionId: version.id, fromItemId: itemIds[0]!, toItemId: itemIds[1]!, kind: "DISSOLVE", durationMs: 400 } });
    await db.wizardStepState.updateMany({ where: { wizardProgress: { projectVersionId: created.projectVersionId }, stepKey: "refinement" },
      data: { status: "COMPLETED", completedAt: new Date(), lockedAt: new Date() } });
    return { ...created, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
