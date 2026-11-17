import { describe, expect, it } from "vitest";
import type { RenderManifest } from "@/lib/finish-export/manifest";
import { buildEdl, buildFcpxml, buildMediaManifest, framesToTimecode, frameDuration, type InterchangeMedia } from "./interchange";
import { deriveVariantManifest } from "./presets";

const uuid = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

function manifest(fps = 24): RenderManifest {
  return {
    schemaVersion: 1, projectVersionId: uuid(1), sourceTimelineVersionId: uuid(2), sourceTimelineNodeId: uuid(3),
    audioMasterAssetVersionId: uuid(4), audioMasterNodeId: uuid(5),
    output: { width: 1920, height: 1080, frameRate: fps, aspectRatio: "16:9", container: "mp4", videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" },
    durationMs: 7000, expectedFrameCount: 7 * fps,
    items: [
      { position: 0, shotVersionId: uuid(10), clipAssetVersionId: uuid(20), clipNodeId: uuid(30), timelineStartMs: 0, timelineEndMs: 2500, sourceStartMs: 500, sourceEndMs: 3000 },
      { position: 1, shotVersionId: uuid(11), clipAssetVersionId: uuid(21), clipNodeId: uuid(31), timelineStartMs: 2500, timelineEndMs: 5000, sourceStartMs: 0, sourceEndMs: 2500, framing: { mode: "fill", zoom: 1.5, focusX: 0.2, focusY: 0.5 } },
      { position: 2, shotVersionId: uuid(12), clipAssetVersionId: uuid(20), clipNodeId: uuid(30), timelineStartMs: 5000, timelineEndMs: 7000, sourceStartMs: 1000, sourceEndMs: 3000 },
    ],
    transitions: [{ fromPosition: 0, toPosition: 1, kind: "DISSOLVE", durationMs: 500, parameters: null }],
  };
}

const media: InterchangeMedia = {
  clips: new Map([
    [uuid(20), { fileName: "shot-001-a.mp4", durationMs: 4000, checksumSha256: "aa", contentType: "video/mp4" }],
    [uuid(21), { fileName: "shot-002-b & <c>.mp4", durationMs: 3000, checksumSha256: "bb", contentType: "video/mp4" }],
  ]),
  audio: { fileName: "music-master.wav", durationMs: 7000, checksumSha256: "cc", contentType: "audio/wav" },
};

/** Minimal XML well-formedness check: balanced tags, quoted attributes, single root. */
function parseXml(xml: string) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "").replace(/^<!DOCTYPE[^>]*>\s*/, "");
  const stack: string[] = [];
  const elements: { name: string; attrs: Record<string, string>; parent: string | null }[] = [];
  const tag = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  let roots = 0;
  while ((match = tag.exec(body))) {
    if (match.index !== consumed) throw new Error("Unparsable XML near " + body.slice(consumed, consumed + 40));
    consumed = tag.lastIndex;
    if (match[5] !== undefined) {
      if (match[5].trim() && !stack.length) throw new Error("Text outside root");
      if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(match[5])) throw new Error("Unescaped ampersand");
      continue;
    }
    const [, closing, name, attrText, selfClosing] = match;
    if (closing) {
      if (stack.pop() !== name) throw new Error("Mismatched </" + name + ">");
      continue;
    }
    if (!stack.length) roots += 1;
    const attrs: Record<string, string> = {};
    for (const a of attrText!.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(a[2]!)) throw new Error("Unescaped ampersand in attribute");
      attrs[a[1]!] = a[2]!;
    }
    elements.push({ name: name!, attrs, parent: stack.at(-1) ?? null });
    if (!selfClosing) stack.push(name!);
  }
  if (consumed !== body.length || stack.length || roots !== 1) throw new Error("XML not well formed");
  return elements;
}

const seconds = (value: string) => {
  if (value === "0s") return 0;
  const [n, d] = value.replace(/s$/, "").split("/").map(Number);
  return n! / (d ?? 1);
};

describe("FCPXML export", () => {
  it("is well-formed with resolvable refs and a contiguous spine", () => {
    const xml = buildFcpxml({ projectTitle: "Song & Video", manifest: manifest(), media });
    const elements = parseXml(xml);
    expect(elements[0]).toMatchObject({ name: "fcpxml", attrs: { version: "1.9" } });
    const ids = new Set(elements.filter((e) => e.attrs.id).map((e) => e.attrs.id));
    const spine = elements.filter((e) => e.name === "asset-clip" && e.parent === "spine");
    expect(spine).toHaveLength(3);
    for (const clip of elements.filter((e) => e.name === "asset-clip")) expect(ids.has(clip.attrs.ref!)).toBe(true);
    let cursor = 0;
    for (const clip of spine) {
      expect(seconds(clip.attrs.offset!)).toBeCloseTo(cursor, 6);
      cursor += seconds(clip.attrs.duration!);
    }
    const sequence = elements.find((e) => e.name === "sequence")!;
    expect(cursor).toBeCloseTo(seconds(sequence.attrs.duration!), 6);
    expect(seconds(spine[0]!.attrs.start!)).toBeCloseTo(0.5, 6);
    const music = elements.find((e) => e.name === "asset-clip" && e.attrs.lane === "-1")!;
    expect(seconds(music.attrs.duration!)).toBeCloseTo(7, 6);
    expect(xml).toContain("shot-002-b &amp; &lt;c&gt;.mp4");
    expect(elements.filter((e) => e.name === "media-rep").every((e) => e.attrs.src!.startsWith("media/"))).toBe(true);
  });

  it("uses NTSC rational frame durations", () => {
    expect(frameDuration(29.97)).toEqual({ num: 1001, den: 30000 });
    expect(frameDuration(25)).toEqual({ num: 1, den: 25 });
    expect(() => parseXml(buildFcpxml({ projectTitle: "x", manifest: manifest(29.97), media }))).not.toThrow();
  });
});

describe("CMX3600 EDL export", () => {
  it("has valid event lines with matching source/record durations and contiguous record time", () => {
    const edl = buildEdl({ projectTitle: "Song", manifest: manifest(), media });
    const lines = edl.split("\n");
    expect(lines[0]).toBe("TITLE: Song");
    expect(lines[1]).toBe("FCM: NON-DROP FRAME");
    const event = /^(\d{3})  (.{8}) (V |AA)\s+C\s+(\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d)$/;
    const events = lines.filter((line) => /^\d{3} /.test(line)).map((line) => {
      const m = event.exec(line);
      expect(m, line).not.toBeNull();
      return m!;
    });
    expect(events).toHaveLength(4);
    const toFrames = (tc: string) => tc.split(":").map(Number).reduce((acc, n, i) => (i < 3 ? acc * (i === 0 ? 1 : 60) + n : acc * 24 + n), 0);
    let record = toFrames("01:00:00:00");
    events.forEach((m, index) => {
      expect(Number(m[1])).toBe(index + 1);
      expect(toFrames(m[5]!) - toFrames(m[4]!)).toBe(toFrames(m[7]!) - toFrames(m[6]!));
      if (m[3] === "V ") {
        expect(toFrames(m[6]!)).toBe(record);
        record = toFrames(m[7]!);
      }
    });
    expect(record - toFrames("01:00:00:00")).toBe(7 * 24);
    expect(edl).toContain("* FROM CLIP NAME: shot-001-a.mp4");
    expect(edl).toContain("DISSOLVE 500 MS");
    expect(framesToTimecode(24 * 3661 + 5, 24)).toBe("01:01:01:05");
  });
});

describe("media manifest and variants", () => {
  it("lists each referenced file once with paths matching the interchange files", () => {
    const m = buildMediaManifest({ projectTitle: "Song", manifest: manifest(), media });
    expect(m.clips.map((c) => c.path)).toEqual(["media/shot-001-a.mp4", "media/shot-002-b & <c>.mp4"]);
    expect(m.audio.path).toBe("media/music-master.wav");
  });

  it("derives vertical/square reframes from existing framing", () => {
    const vertical = deriveVariantManifest(manifest(), { presetKey: "vertical-1080", framingMode: "fill", focusOverrides: { "0": { focusX: 0.8 } } });
    expect(vertical.output).toMatchObject({ width: 1080, height: 1920, aspectRatio: "9:16" });
    expect(vertical.items[0]!.framing).toEqual({ mode: "fill", zoom: 1, focusX: 0.8, focusY: 0.5 });
    expect(vertical.items[1]!.framing).toEqual({ mode: "fill", zoom: 1.5, focusX: 0.2, focusY: 0.5 });
    expect(vertical.durationMs).toBe(7000);
    const square = deriveVariantManifest(manifest(), { presetKey: "square-1080", framingMode: "fit" });
    expect(square.output.width).toBe(square.output.height);
    expect(square.items.every((item) => item.framing === undefined)).toBe(true);
  });
});
