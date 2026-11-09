import { runMediaProcess } from "@/lib/media/process";

export class MediaImportError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function detectImportedMedia(bytes: Uint8Array, kind: "image" | "video") {
  const ascii = (start: number, length: number) => Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
  if (kind === "image") {
    if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { contentType: "image/png", extension: "png" };
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { contentType: "image/jpeg", extension: "jpg" };
    if (ascii(0,4) === "RIFF" && ascii(8,4) === "WEBP") return { contentType: "image/webp", extension: "webp" };
    throw new MediaImportError("Upload a PNG, JPEG or WebP image.");
  }
  if (bytes.length >= 12 && ascii(4,4) === "ftyp") return { contentType: "video/mp4", extension: "mp4" };
  if (Buffer.from(bytes.subarray(0,4)).equals(Buffer.from([26,69,223,163]))) return { contentType: "video/webm", extension: "webm" };
  throw new MediaImportError("Upload an H.264 MP4 or VP8/VP9 WebM clip.");
}

export async function probeImportedMedia(input: {
  path: string; kind: "image" | "video"; contentType: string; ffmpeg: string; ffprobe: string; signal: AbortSignal;
}) {
  let report: { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string }>;
    format?: { duration?: string } };
  try {
    const output = await runMediaProcess({ executable: input.ffprobe,
      args: ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", input.path],
      signal: input.signal, captureStdout: true, description: "Imported media inspection" });
    report = JSON.parse(output);

  } catch {
    throw new MediaImportError("The uploaded media could not be decoded. Use a valid supported image or video file.");
  }
  const streams = report.streams?.filter(stream => stream.codec_type === "video") ?? [];
  const stream = streams[0];
  if (streams.length !== 1 || !stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) ||
      stream.width! < 1 || stream.height! < 1 || stream.width! > 8192 || stream.height! > 8192) {
    throw new MediaImportError("Media must contain one visual stream, at most 8192 pixels on either side.");
  }
  const [numerator, denominator] = (stream.avg_frame_rate ?? "").split("/").map(Number);
  const frameRate = numerator! / denominator!;
  const durationMs = Math.round(Number(stream.duration ?? report.format?.duration) * 1000);
  if (input.kind === "image") {
    const expected: Record<string, string> = { "image/png": "png", "image/jpeg": "mjpeg", "image/webp": "webp" };
    if (stream.codec_name !== expected[input.contentType]) throw new MediaImportError("The decoded image does not match its file signature.");
  }
  if (input.kind === "video") {
    const allowed = input.contentType === "video/mp4" ? ["h264"] : ["vp8", "vp9"];
    if (!allowed.includes(stream.codec_name ?? "")) throw new MediaImportError("Use H.264 in MP4 or VP8/VP9 in WebM for browser playback.");
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 300000 || !Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 120) {
      throw new MediaImportError("Clips must be playable, at most five minutes long and at most 120 fps.");
    }
  }
  try {
    await runMediaProcess({ executable: input.ffmpeg,
      args: ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", input.path, "-map", "0:v:0", "-an", "-threads", "1",
        ...(input.kind === "image" ? ["-frames:v", "1"] : []), "-f", "null", "-"],
      signal: input.signal, description: "Imported media decode" });
  } catch {
    throw new MediaImportError("The uploaded media could not be fully decoded.");
  }
  return { width: stream.width!, height: stream.height!, durationMs: input.kind === "video" ? durationMs : null,
    frameRate: input.kind === "video" ? frameRate : null };
}

export async function readBoundedFormData(request: Request, limit: number): Promise<FormData> {
  const length = Number(request.headers.get("content-length"));
  if (length > limit) throw new MediaImportError("The uploaded media exceeds the upload limit.", 413);
  if (!request.body) throw new MediaImportError("A media file is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new MediaImportError("The uploaded media exceeds the upload limit.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const copy = new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type") ?? "" }, body: Buffer.concat(chunks) });
  try { return await copy.formData(); }
  catch { throw new MediaImportError("Use a multipart form with a media file."); }
}
