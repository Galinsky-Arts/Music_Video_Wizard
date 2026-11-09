import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMediaProcess } from "../src/lib/media/process";
import { buildFfmpegRenderCommand } from "../src/lib/finish-export/ffmpeg";
import { compileRenderManifest } from "../src/lib/finish-export/manifest";
import { verifyRenderedMaster } from "../src/lib/finish-export/verification";

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "mvw-render-smoke-"));
  const ffmpeg = process.env.VIDEO_RENDER_FFMPEG ?? process.env.AUDIO_ANALYSIS_FFMPEG ?? "ffmpeg";
  const ffprobe = process.env.VIDEO_RENDER_FFPROBE ?? "ffprobe";
  const signal = AbortSignal.timeout(120_000);
  const run = (args: string[]) => runMediaProcess({ executable: ffmpeg, args, signal, description: "Render fixture" });
  try {
    // Different source rates, dimensions and trims; one source is reused in two placements.
    const clipPaths = [join(directory, "red.mp4"), join(directory, "blue.mp4"), join(directory, "red.mp4")];
    for (const [index, color, size, rate] of [[0, "red", "160x90", "25"], [1, "blue", "120x120", "30"]] as const) {
      await run(["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=${rate}:d=2`, "-y", clipPaths[index]!]);
    }
    const audioPath = join(directory, "master.wav");
    await run(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-y", audioPath]);
    for (const frameRate of [24, 23.976, 29.97]) {
      for (const durations of [[0, 0], [400, 0], [0, 400], [400, 400]]) {
        const manifest = compileRenderManifest({
          projectVersionId: "fixture", sourceTimelineVersionId: "timeline", sourceTimelineNodeId: "timeline-node",
          audioMasterAssetVersionId: "audio", audioMasterNodeId: "audio-node", audioContentType: "audio/wav", audioDurationMs: 3000,
          width: 160, height: 90, frameRate, aspectRatio: "16:9",
          items: [0, 1, 2].map(position => ({ position, shotVersionId: "shot-" + position,
            clipAssetVersionId: "clip-" + position, clipNodeId: "clip-node-" + position, contentType: "video/mp4",
            timelineStartMs: position * 1000, timelineEndMs: (position + 1) * 1000,
            sourceStartMs: 200, sourceEndMs: 1200, clipDurationMs: 2000 })),
          transitions: durations.map((durationMs, fromPosition) => ({ fromPosition, toPosition: fromPosition + 1,
            kind: "DISSOLVE", durationMs, parameters: {} }))
        });
        const outputPath = join(directory, "master.mp4");
        const command = buildFfmpegRenderCommand({ executable: ffmpeg, manifest, clipPaths, audioPath, outputPath });
        await runMediaProcess({ ...command, signal, description: "Final master render" });
        const verified = await verifyRenderedMaster({ ffmpeg, ffprobe, path: outputPath, manifest, signal });
        assert.ok(Math.abs(verified.durationMs - 3000) <= 50);
        // A readable but shortened soundtrack must not pass as a finished video.
        await assert.rejects(verifyRenderedMaster({ ffmpeg, ffprobe, path: outputPath,
          manifest: { ...manifest, durationMs: 5000, expectedFrameCount: Math.round(5 * frameRate) }, signal }), /frame count|duration/);
        console.log(`render: ${frameRate} fps, transitions ${durations.join("/")}: verified`);
      }
    }
    // Verify a full-length soundtrack at fractional frame rate, including the end.
    const longClip = join(directory, "long.mp4");
    const longAudio = join(directory, "long.wav");
    await run(["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=160x90:r=30:d=61", "-y", longClip]);
    await run(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=180", "-y", longAudio]);
    const longManifest = compileRenderManifest({
      projectVersionId: "long-fixture", sourceTimelineVersionId: "timeline", sourceTimelineNodeId: "timeline-node",
      audioMasterAssetVersionId: "audio", audioMasterNodeId: "audio-node", audioContentType: "audio/wav", audioDurationMs: 180000,
      width: 160, height: 90, frameRate: 29.97, aspectRatio: "16:9",
      items: [0, 1, 2].map(position => ({ position, shotVersionId: "shot-" + position,
        clipAssetVersionId: "reused-long-clip", clipNodeId: "clip-node", contentType: "video/mp4",
        timelineStartMs: position * 60000, timelineEndMs: (position + 1) * 60000,
        sourceStartMs: 200, sourceEndMs: 60200, clipDurationMs: 61000 })),
      transitions: [0, 1].map(fromPosition => ({ fromPosition, toPosition: fromPosition + 1,
        kind: "DISSOLVE", durationMs: 400, parameters: {} }))
    });
    const longOutput = join(directory, "long-master.mp4");
    await runMediaProcess({ ...buildFfmpegRenderCommand({ executable: ffmpeg, manifest: longManifest,
      clipPaths: [longClip, longClip, longClip], audioPath: longAudio, outputPath: longOutput }), signal, description: "Full-length master" });
    await verifyRenderedMaster({ ffmpeg, ffprobe, path: longOutput, manifest: longManifest, signal });
    console.log("render: 180-second soundtrack at 29.97 fps: verified");
    const broken = join(directory, "broken.mp4");
    await writeFile(broken, "not a video");
    const command = new AbortController();
    command.abort(new Error("Cancelled render"));
    await assert.rejects(runMediaProcess({ executable: ffmpeg, args: ["-version"], signal: command.signal, description: "Cancelled render" }), /Cancelled render/);
    await assert.rejects(runMediaProcess({ executable: ffmpeg, args: ["-v", "error", "-xerror", "-i", broken, "-f", "null", "-"], signal, description: "Corrupt render" }), /failed/);
    console.log("Real FFmpeg render acceptance passed (13 delivery cases, corrupt media and cancellation).");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
