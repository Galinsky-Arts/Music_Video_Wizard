import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectImportedMedia, probeImportedMedia } from "@/lib/media-imports/probe";
import { PermanentGenerationError } from "@/lib/jobs/registry";
export async function verifyGeneratedClip(input: { bytes: Uint8Array; minimumDurationMs: number; maxBytes: number;
  ffmpeg: string; ffprobe: string; signal: AbortSignal }) {
  if (!input.bytes.byteLength || input.bytes.byteLength > input.maxBytes) throw new PermanentGenerationError("Generated video is empty or exceeds the media size limit.");
  const directory = await mkdtemp(join(tmpdir(), "mvw-generated-clip-"));
  try {
    const type = detectImportedMedia(input.bytes, "video"), path = join(directory, "clip." + type.extension);
    await writeFile(path,input.bytes);
    const measured = await probeImportedMedia({ path, kind: "video", contentType: type.contentType, ffmpeg: input.ffmpeg, ffprobe: input.ffprobe,
      signal: AbortSignal.any([input.signal,AbortSignal.timeout(120000)]) });
    if (measured.durationMs! < input.minimumDurationMs) throw new Error("Generated video does not cover the requested shot and handles.");
    return { ...type,...measured };
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new PermanentGenerationError(error instanceof Error ? error.message : "Generated video verification failed.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
