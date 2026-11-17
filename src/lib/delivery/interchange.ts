import type { RenderManifest } from "@/lib/finish-export/manifest";

/**
 * Editing interchange (plan PR 26): FCPXML 1.9 and CMX3600 EDL for the locked
 * timeline, plus a media manifest naming every referenced file. Editors relink
 * by file name after downloading the media listed in the manifest.
 * Transitions are exported as cuts with a note (FCPXML) / comment (EDL).
 */
export interface InterchangeMedia {
  clips: Map<string, { fileName: string; durationMs: number | null; checksumSha256: string | null; contentType: string }>;
  audio: { fileName: string; durationMs: number | null; checksumSha256: string | null; contentType: string };
}

export interface InterchangeInput {
  projectTitle: string;
  manifest: RenderManifest;
  media: InterchangeMedia;
}

/** Rational frame duration for FCPXML, e.g. 29.97 -> 1001/30000. */
export function frameDuration(fps: number): { num: number; den: number } {
  const ntsc: Record<string, { num: number; den: number }> = {
    "23.976": { num: 1001, den: 24000 }, "29.97": { num: 1001, den: 30000 }, "59.94": { num: 1001, den: 60000 },
  };
  const key = (Math.round(fps * 1000) / 1000).toString();
  if (ntsc[key]) return ntsc[key];
  if (Number.isInteger(fps)) return { num: 1, den: fps };
  return { num: 100, den: Math.round(fps * 100) };
}

export function msToFrames(ms: number, fps: number) {
  return Math.round((ms * fps) / 1000);
}

function rational(frames: number, fd: { num: number; den: number }) {
  if (frames === 0) return "0s";
  return frames * fd.num + "/" + fd.den + "s";
}

export function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sortedItems(manifest: RenderManifest) {
  return [...manifest.items].sort((a, b) => a.position - b.position);
}

export function buildFcpxml(input: InterchangeInput) {
  const { manifest, media } = input;
  const fps = manifest.output.frameRate;
  const fd = frameDuration(fps);
  const items = sortedItems(manifest);
  const totalFrames = msToFrames(manifest.durationMs, fps);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.9">', "  <resources>");
  lines.push(`    <format id="r1" name="MVW_${manifest.output.width}x${manifest.output.height}" frameDuration="${rational(1, fd)}" width="${manifest.output.width}" height="${manifest.output.height}"/>`);
  const assetIds = new Map<string, string>();
  let next = 2;
  for (const item of items) {
    if (assetIds.has(item.clipAssetVersionId)) continue;
    const clip = media.clips.get(item.clipAssetVersionId);
    if (!clip) throw new Error("Missing media for clip " + item.clipAssetVersionId);
    const id = "r" + next++;
    assetIds.set(item.clipAssetVersionId, id);
    const durationFrames = msToFrames(clip.durationMs ?? item.sourceEndMs, fps);
    lines.push(`    <asset id="${id}" name="${xmlEscape(clip.fileName)}" start="0s" duration="${rational(durationFrames, fd)}" hasVideo="1" hasAudio="0" format="r1">`);
    lines.push(`      <media-rep kind="original-media" src="${xmlEscape("media/" + clip.fileName)}"/>`, "    </asset>");
  }
  const audioId = "r" + next;
  const audioFrames = msToFrames(media.audio.durationMs ?? manifest.durationMs, fps);
  lines.push(`    <asset id="${audioId}" name="${xmlEscape(media.audio.fileName)}" start="0s" duration="${rational(audioFrames, fd)}" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">`);
  lines.push(`      <media-rep kind="original-media" src="${xmlEscape("media/" + media.audio.fileName)}"/>`, "    </asset>", "  </resources>");
  const title = xmlEscape(input.projectTitle);
  lines.push("  <library>", `    <event name="${title}">`, `      <project name="${title}">`);
  lines.push(`        <sequence format="r1" duration="${rational(totalFrames, fd)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`, "          <spine>");
  items.forEach((item, index) => {
    const offset = msToFrames(item.timelineStartMs, fps);
    const end = index + 1 < items.length ? msToFrames(items[index + 1]!.timelineStartMs, fps) : totalFrames;
    const duration = Math.max(1, end - offset);
    const start = msToFrames(item.sourceStartMs, fps);
    const clip = media.clips.get(item.clipAssetVersionId)!;
    const attrs = `ref="${assetIds.get(item.clipAssetVersionId)}" name="${xmlEscape("Shot " + (item.position + 1) + " - " + clip.fileName)}" offset="${rational(offset, fd)}" start="${rational(start, fd)}" duration="${rational(duration, fd)}"`;
    const transition = manifest.transitions.find((entry) => entry.fromPosition === item.position);
    const inner: string[] = [];
    if (index === 0) {
      // Music master as a connected clip below the first spine clip, spanning the whole edit.
      inner.push(`              <asset-clip ref="${audioId}" lane="-1" name="${xmlEscape(media.audio.fileName)}" offset="${rational(start, fd)}" start="0s" duration="${rational(totalFrames, fd)}"/>`);
    }
    if (transition) inner.push(`              <note>${xmlEscape("Transition to next shot: " + transition.kind + " " + transition.durationMs + " ms")}</note>`);
    if (inner.length) lines.push(`            <asset-clip ${attrs}>`, ...inner, "            </asset-clip>");
    else lines.push(`            <asset-clip ${attrs}/>`);
  });
  lines.push("          </spine>", "        </sequence>", "      </project>", "    </event>", "  </library>", "</fcpxml>");
  return lines.join("\n") + "\n";
}

/** Integer timecode base used for EDL timecode (NDF). */
export function edlTimecodeBase(fps: number) {
  return Math.round(fps);
}

export function framesToTimecode(frames: number, base: number) {
  const f = frames % base;
  const totalSeconds = Math.floor(frames / base);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return [h, m, s, f].map((n) => String(n).padStart(2, "0")).join(":");
}

export function buildEdl(input: InterchangeInput) {
  const { manifest, media } = input;
  const fps = manifest.output.frameRate;
  const base = edlTimecodeBase(fps);
  const items = sortedItems(manifest);
  const totalFrames = msToFrames(manifest.durationMs, fps);
  const recordStart = 3600 * base; // 01:00:00:00
  const title = input.projectTitle.replace(/[^\x20-\x7e]/g, "_").slice(0, 60) || "MUSIC VIDEO";
  const out: string[] = ["TITLE: " + title, "FCM: NON-DROP FRAME", ""];
  let event = 1;
  const num = () => String(event++).padStart(3, "0");
  items.forEach((item, index) => {
    const recIn = msToFrames(item.timelineStartMs, fps);
    const recOut = index + 1 < items.length ? msToFrames(items[index + 1]!.timelineStartMs, fps) : totalFrames;
    const duration = Math.max(1, recOut - recIn);
    const srcIn = msToFrames(item.sourceStartMs, fps);
    const reel = ("S" + String(item.position + 1).padStart(4, "0")).slice(0, 8).padEnd(8, " ");
    const clip = media.clips.get(item.clipAssetVersionId)!;
    out.push(`${num()}  ${reel} V     C        ${framesToTimecode(srcIn, base)} ${framesToTimecode(srcIn + duration, base)} ${framesToTimecode(recordStart + recIn, base)} ${framesToTimecode(recordStart + recIn + duration, base)}`);
    out.push("* FROM CLIP NAME: " + clip.fileName);
    const transition = manifest.transitions.find((entry) => entry.fromPosition === item.position);
    if (transition) out.push(`* TRANSITION TO NEXT: ${transition.kind} ${transition.durationMs} MS (EXPORTED AS CUT)`);
    out.push("");
  });
  out.push(`${num()}  MUSIC    AA    C        ${framesToTimecode(0, base)} ${framesToTimecode(totalFrames, base)} ${framesToTimecode(recordStart, base)} ${framesToTimecode(recordStart + totalFrames, base)}`);
  out.push("* FROM CLIP NAME: " + media.audio.fileName, "");
  return out.join("\n");
}

export function buildMediaManifest(input: InterchangeInput & { signedUrls?: Map<string, string> }) {
  const items = sortedItems(input.manifest);
  const seen = new Set<string>();
  const clips = [];
  for (const item of items) {
    if (seen.has(item.clipAssetVersionId)) continue;
    seen.add(item.clipAssetVersionId);
    const clip = input.media.clips.get(item.clipAssetVersionId)!;
    clips.push({ assetVersionId: item.clipAssetVersionId, path: "media/" + clip.fileName, contentType: clip.contentType, durationMs: clip.durationMs, checksumSha256: clip.checksumSha256, downloadUrl: input.signedUrls?.get(item.clipAssetVersionId) ?? null });
  }
  return {
    schemaVersion: 1,
    generator: "Music Video Wizard",
    project: input.projectTitle,
    sequence: { width: input.manifest.output.width, height: input.manifest.output.height, frameRate: input.manifest.output.frameRate, durationMs: input.manifest.durationMs },
    instructions: "Download each file into a folder named 'media' next to the .fcpxml/.edl, then import the FCPXML (Final Cut Pro, DaVinci Resolve) or EDL (Premiere Pro, Avid, Resolve) and relink by file name. Download links expire.",
    audio: { assetVersionId: input.manifest.audioMasterAssetVersionId, path: "media/" + input.media.audio.fileName, contentType: input.media.audio.contentType, durationMs: input.media.audio.durationMs, checksumSha256: input.media.audio.checksumSha256, downloadUrl: input.signedUrls?.get(input.manifest.audioMasterAssetVersionId) ?? null },
    clips,
  };
}

export function clipFileName(position: number, assetVersionId: string, contentType: string) {
  const ext = contentType.includes("quicktime") ? "mov" : contentType.includes("webm") ? "webm" : "mp4";
  return "shot-" + String(position + 1).padStart(3, "0") + "-" + assetVersionId.slice(0, 8) + "." + ext;
}

export function audioFileName(contentType: string) {
  const ext = contentType.includes("wav") ? "wav" : contentType.includes("flac") ? "flac" : contentType.includes("aiff") ? "aiff" : contentType.includes("mp4") || contentType.includes("aac") ? "m4a" : "mp3";
  return "music-master." + ext;
}
