import { z } from "zod";
import { runMediaProcess } from "@/lib/media/process";
import type { RenderManifest } from "./manifest";

const streamSchema = z.object({
  codec_type: z.string(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  nb_frames: z.string().optional(),
  duration: z.string().optional(),
  start_time: z.string().optional()
});
const probeSchema = z.object({
  streams: z.array(streamSchema),
  format: z.object({ format_name: z.string() })
});

export interface VerifiedMaster {
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  durationMs: number;
  audioDurationMs: number;
}

export function validateRenderedMaster(value: unknown, manifest: RenderManifest): VerifiedMaster {
  const probe = probeSchema.parse(value);
  const video = probe.streams.filter(stream => stream.codec_type === "video");
  const audio = probe.streams.filter(stream => stream.codec_type === "audio");
  if (video.length !== 1 || audio.length !== 1 || probe.streams.length !== 2) {
    throw new Error("Rendered master must contain exactly one video and one audio stream.");
  }
  const v = video[0]!;
  const a = audio[0]!;
  if (!probe.format.format_name.split(",").includes("mp4") ||
      v.codec_name !== manifest.output.videoCodec || a.codec_name !== manifest.output.audioCodec ||
      v.pix_fmt !== manifest.output.pixelFormat) {
    throw new Error("Rendered master container, codecs or pixel format do not match delivery settings.");
  }
  if (v.width !== manifest.output.width || v.height !== manifest.output.height) {
    throw new Error("Rendered master dimensions do not match delivery settings.");
  }
  const [numerator, denominator] = (v.avg_frame_rate ?? "").split("/").map(Number);
  const frameRate = numerator! / denominator!;
  if (!Number.isFinite(frameRate) || Math.abs(frameRate - manifest.output.frameRate) > 0.001) {
    throw new Error("Rendered master frame rate does not match delivery settings.");
  }
  const frameCount = Number(v.nb_frames);
  // FFmpeg may round a millisecond boundary to the adjacent output frame.
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 ||
      Math.abs(frameCount - manifest.expectedFrameCount) > 1) {
    throw new Error("Rendered master frame count does not match the locked timeline.");
  }
  const durationMs = Number(v.duration) * 1000;
  const audioDurationMs = Number(a.duration) * 1000;
  const toleranceMs = Math.max(50, 1000 / frameRate);
  for (const [label, duration] of [["video", durationMs], ["audio", audioDurationMs]] as const) {
    if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - manifest.durationMs) > toleranceMs) {
      throw new Error("Rendered master " + label + " duration does not match the locked timeline.");
    }
  }
  for (const stream of [v, a]) {
    const startMs = Number(stream.start_time) * 1000;
    if (!Number.isFinite(startMs) || Math.abs(startMs) > toleranceMs) {
      throw new Error("Rendered master streams must start at the locked timeline origin.");
    }
  }
  return { width: v.width!, height: v.height!, frameRate, frameCount,
    durationMs: Math.round(durationMs), audioDurationMs: Math.round(audioDurationMs) };
}

export async function verifyRenderedMaster(input: {
  ffmpeg: string;
  ffprobe: string;
  path: string;
  manifest: RenderManifest;
  signal: AbortSignal;
}): Promise<VerifiedMaster> {
  // Decode both complete streams. Stream-copying only checks that packets can be demuxed.
  await runMediaProcess({
    executable: input.ffmpeg,
    args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
      "-err_detect", "explode", "-i", input.path, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
    signal: input.signal,
    description: "Rendered master decode verification"
  });
  const result = await runMediaProcess({
    executable: input.ffprobe,
    args: ["-v", "error", "-show_streams", "-show_format", "-of", "json", input.path],
    signal: input.signal,
    description: "Rendered master delivery verification",
    captureStdout: true
  });
  return validateRenderedMaster(JSON.parse(result), input.manifest);
}
