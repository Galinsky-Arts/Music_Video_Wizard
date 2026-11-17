import { randomUUID } from "node:crypto";
import { AssetKind, GenerationKind, GenerationStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { projectEditorWhere } from "@/lib/collaboration/access";
import { getCurrentRenderManifest } from "@/lib/finish-export/service";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import { createAssetStorage } from "@/lib/storage";
import { DELIVERY_PRESETS, deriveVariantManifest, isDeliveryPresetKey, type FocusOverride } from "./presets";
import { audioFileName, buildEdl, buildFcpxml, buildMediaManifest, clipFileName, type InterchangeMedia } from "./interchange";

export class DeliveryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const PROVIDER_KEY = "ffmpeg:delivery-variant";

async function requireProject(userId: string, projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, archivedAt: null, ...projectEditorWhere(userId) },
    select: { id: true, title: true, workspaceId: true }
  });
  if (!project) throw new DeliveryError("Project not found.", 404);
  return project;
}

export async function queueDeliveryVariant(input: {
  userId: string; projectId: string; presetKey: string; framingMode: "fill" | "fit"; focusOverrides?: Record<string, FocusOverride>;
}) {
  const project = await requireProject(input.userId, input.projectId);
  if (!isDeliveryPresetKey(input.presetKey)) throw new DeliveryError("Unknown delivery preset.");
  if (input.framingMode !== "fill" && input.framingMode !== "fit") throw new DeliveryError("Framing must be fill or fit.");
  const { manifest: base } = await getCurrentRenderManifest(input);
  const manifest = deriveVariantManifest(base, { presetKey: input.presetKey, framingMode: input.framingMode, focusOverrides: input.focusOverrides });
  const manifestFingerprint = fingerprintJson(JSON.parse(JSON.stringify(manifest)) as Prisma.JsonValue);
  const preset = DELIVERY_PRESETS[input.presetKey];
  // One variant render at a time per project keeps the 512 MB renderer within limits.
  const active = await db.generationJob.findFirst({
    where: { projectId: project.id, kind: GenerationKind.RENDER, status: { in: [GenerationStatus.QUEUED, GenerationStatus.RUNNING] } },
    select: { id: true }
  });
  if (active) throw new DeliveryError("Another render is already running for this project. Try again when it finishes.", 409);
  const name = "Delivery: " + input.presetKey;
  const existing = await db.asset.findFirst({ where: { projectId: project.id, kind: AssetKind.DELIVERY_VARIANT, name }, select: { id: true } });
  const renderAssetId = existing?.id ?? randomUUID();
  const job = await enqueueGenerationJob({
    workspaceId: project.workspaceId,
    projectId: project.id,
    kind: GenerationKind.RENDER,
    providerKey: PROVIDER_KEY,
    modelKey: "ffmpeg",
    requestSnapshot: JSON.parse(JSON.stringify({
      schemaVersion: 1, projectId: project.id, renderAssetId, manifest, manifestFingerprint,
      variant: { presetKey: input.presetKey, label: preset.label, framingMode: input.framingMode }
    })),
    requestedByUserId: input.userId,
    inputs: [
      { nodeId: manifest.sourceTimelineNodeId, role: "timeline", position: 0 },
      { nodeId: manifest.audioMasterNodeId, role: "audio-master", position: 0 },
      ...manifest.items.map((item) => ({ nodeId: item.clipNodeId, role: "video-clip", position: item.position }))
    ],
    prepare: async (tx) => {
      await tx.asset.upsert({
        where: { id: renderAssetId },
        create: { id: renderAssetId, workspaceId: project.workspaceId, projectId: project.id, kind: AssetKind.DELIVERY_VARIANT, name },
        update: {}
      });
    }
  });
  return { jobId: job.id, status: job.status };
}

export async function listDeliveryVariants(input: { userId: string; projectId: string }) {
  const project = await requireProject(input.userId, input.projectId);
  const [assets, jobs] = await Promise.all([
    db.asset.findMany({
      where: { projectId: project.id, kind: AssetKind.DELIVERY_VARIANT },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } }
    }),
    db.generationJob.findMany({
      where: { projectId: project.id, providerKey: PROVIDER_KEY },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, status: true, progressPercent: true, progressMessage: true, errorMessage: true, createdAt: true, requestSnapshot: true }
    })
  ]);
  const storage = createAssetStorage();
  const variants = await Promise.all(assets.filter((asset) => asset.versions[0]?.status === "READY").map(async (asset) => {
    const version = asset.versions[0]!;
    const presetKey = (asset.name ?? "").replace(/^Delivery: /, "");
    return {
      presetKey,
      label: isDeliveryPresetKey(presetKey) ? DELIVERY_PRESETS[presetKey].label : presetKey,
      width: version.width, height: version.height, durationMs: version.durationMs,
      byteSize: version.byteSize?.toString() ?? null, createdAt: version.createdAt,
      downloadUrl: await storage.getSignedReadUrl(version.storageKey, 60 * 30, project.title.replace(/[^\w -]/g, "_") + " - " + presetKey + ".mp4")
    };
  }));
  return {
    presets: Object.entries(DELIVERY_PRESETS).map(([key, preset]) => ({ key, ...preset })),
    variants,
    jobs: jobs.map((job) => ({
      id: job.id, status: job.status, progressPercent: job.progressPercent, progressMessage: job.progressMessage,
      errorMessage: job.errorMessage, createdAt: job.createdAt,
      presetKey: ((job.requestSnapshot as { variant?: { presetKey?: string } } | null)?.variant?.presetKey) ?? null
    }))
  };
}

export async function buildInterchange(input: { userId: string; projectId: string; format: "fcpxml" | "edl" | "manifest" }) {
  const project = await requireProject(input.userId, input.projectId);
  const { manifest } = await getCurrentRenderManifest(input);
  const clipIds = [...new Set(manifest.items.map((item) => item.clipAssetVersionId))];
  const versions = await db.assetVersion.findMany({
    where: { id: { in: [...clipIds, manifest.audioMasterAssetVersionId] }, asset: { projectId: project.id } },
    select: { id: true, contentType: true, durationMs: true, checksumSha256: true, storageKey: true }
  });
  const byId = new Map(versions.map((version) => [version.id, version]));
  const audio = byId.get(manifest.audioMasterAssetVersionId);
  if (!audio) throw new DeliveryError("The audio master is missing.");
  const media: InterchangeMedia = {
    clips: new Map(),
    audio: { fileName: audioFileName(audio.contentType), durationMs: audio.durationMs, checksumSha256: audio.checksumSha256, contentType: audio.contentType }
  };
  for (const item of [...manifest.items].sort((a, b) => a.position - b.position)) {
    if (media.clips.has(item.clipAssetVersionId)) continue;
    const version = byId.get(item.clipAssetVersionId);
    if (!version) throw new DeliveryError("A timeline clip is missing.");
    media.clips.set(item.clipAssetVersionId, { fileName: clipFileName(item.position, version.id, version.contentType), durationMs: version.durationMs, checksumSha256: version.checksumSha256, contentType: version.contentType });
  }
  const payload = { projectTitle: project.title, manifest, media };
  const baseName = project.title.replace(/[^\w -]/g, "_").trim() || "music-video";
  if (input.format === "fcpxml") return { fileName: baseName + ".fcpxml", contentType: "application/xml", body: buildFcpxml(payload) };
  if (input.format === "edl") return { fileName: baseName + ".edl", contentType: "text/plain", body: buildEdl(payload) };
  const storage = createAssetStorage();
  const signedUrls = new Map<string, string>();
  for (const [id, clip] of media.clips) signedUrls.set(id, await storage.getSignedReadUrl(byId.get(id)!.storageKey, 60 * 60 * 24, clip.fileName));
  signedUrls.set(audio.id, await storage.getSignedReadUrl(audio.storageKey, 60 * 60 * 24, media.audio.fileName));
  return { fileName: baseName + "-media.json", contentType: "application/json", body: JSON.stringify(buildMediaManifest({ ...payload, signedUrls }), null, 2) + "\n" };
}
