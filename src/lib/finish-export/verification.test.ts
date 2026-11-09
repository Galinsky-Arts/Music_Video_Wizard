import { describe, expect, it } from "vitest";
import { validateRenderedMaster } from "./verification";
import type { RenderManifest } from "./manifest";

const manifest = {
  output: { width: 160, height: 90, frameRate: 24, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" },
  durationMs: 3000, expectedFrameCount: 72
} as RenderManifest;
function probe() {
  return { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" }, streams: [
    { codec_type: "video", codec_name: "h264", width: 160, height: 90, pix_fmt: "yuv420p",
      avg_frame_rate: "24/1", nb_frames: "72", duration: "3.0", start_time: "0.0" },
    { codec_type: "audio", codec_name: "aac", duration: "3.0", start_time: "0.0" }
  ] };
}

describe("measured master delivery contract", () => {
  it("returns measured properties, allowing one frame of container rounding", () => {
    const value = probe();
    value.streams[0]!.nb_frames = "73";
    value.streams[0]!.duration = "3.041667";
    expect(validateRenderedMaster(value, manifest)).toMatchObject({ frameCount: 73, durationMs: 3042, audioDurationMs: 3000 });
  });
  it.each([
    ["width", 320, /dimensions/], ["height", 180, /dimensions/],
    ["codec_name", "hevc", /codecs/], ["pix_fmt", "yuv444p", /pixel format/],
    ["avg_frame_rate", "30/1", /frame rate/], ["avg_frame_rate", "0/0", /frame rate/],
    ["nb_frames", "50", /frame count/], ["nb_frames", "N\/A", /frame count/],
    ["duration", "1.0", /video duration/], ["start_time", "1.0", /origin/]
  ])("rejects incorrect video %s", (key, value, message) => {
    const report = probe();
    Object.assign(report.streams[0]!, { [key]: value });
    expect(() => validateRenderedMaster(report, manifest)).toThrow(message);
  });
  it("rejects shortened or missing soundtrack", () => {
    const report = probe();
    report.streams[1]!.duration = "1.0";
    expect(() => validateRenderedMaster(report, manifest)).toThrow(/audio duration/);
    report.streams.pop();
    expect(() => validateRenderedMaster(report, manifest)).toThrow(/one video and one audio/);
  });
});
