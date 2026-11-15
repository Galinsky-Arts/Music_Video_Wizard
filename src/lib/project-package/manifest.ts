import { z } from "zod";

export const PACKAGE_FORMAT = "music-video-wizard.project-package";
export const PACKAGE_SCHEMA_VERSION = 1;
/** Bounded for the 512 MB free instance: everything is streamed through disk. */
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PACKAGE_ENTRIES = 2000;

const EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/json": "json"
};

export function extensionForContentType(contentType: string) {
  return EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] ?? "bin";
}

export function mediaEntryName(assetVersionId: string, contentType: string) {
  return "media/" + assetVersionId + "." + extensionForContentType(contentType);
}

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const packageAssetVersionSchema = z.object({
  assetVersionId: uuid,
  versionNumber: z.number().int().positive(),
  contentType: z.string().min(1).max(200),
  byteSize: z.number().int().min(0).nullable(),
  checksumSha256: sha256.nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  frameRate: z.number().positive().nullable(),
  metadata: z.unknown(),
  createdAt: z.string(),
  /** Package path, or null when the media could not be included. */
  path: z.string().nullable()
}).strict();

export const packageAssetSchema = z.object({
  assetId: uuid,
  kind: z.enum([
    "AUDIO_MASTER", "REFERENCE_IMAGE", "STORYBOARD_IMAGE", "GENERATED_IMAGE",
    "GENERATED_VIDEO", "GRAPHIC", "TITLE_CARD", "RENDER_PREVIEW", "RENDER_MASTER", "OTHER"
  ]),
  name: z.string().max(500).nullable(),
  versions: z.array(packageAssetVersionSchema).max(MAX_PACKAGE_ENTRIES)
}).strict();

export const missingMediaSchema = z.object({
  assetVersionId: uuid,
  reason: z.string().max(300)
}).strict();

export const projectPackageManifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
  exportedAt: z.string(),
  source: z.object({ projectId: uuid, projectVersionId: uuid }).strict(),
  project: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(20000).nullable()
  }).strict(),
  projectVersion: z.object({
    versionNumber: z.number().int().positive(),
    aspectRatio: z.string().max(40).nullable(),
    outputWidth: z.number().int().positive().nullable(),
    outputHeight: z.number().int().positive().nullable(),
    frameRate: z.number().positive().nullable(),
    audioMasterAssetVersionId: uuid.nullable()
  }).strict(),
  wizard: z.object({
    currentStepKey: z.string().max(80).nullable(),
    steps: z.array(z.object({
      stepKey: z.string().max(80),
      status: z.string().max(40),
      payload: z.unknown()
    }).strict()).max(100)
  }).strict(),
  assets: z.array(packageAssetSchema).max(MAX_PACKAGE_ENTRIES),
  missingMedia: z.array(missingMediaSchema).max(MAX_PACKAGE_ENTRIES)
}).strict();

export type ProjectPackageManifest = z.infer<typeof projectPackageManifestSchema>;

export const checksumsSchema = z.record(z.string(), sha256);
