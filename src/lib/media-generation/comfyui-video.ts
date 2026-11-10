import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { MediaProviderError } from "./errors";
import type { MediaGenerationAdapter, MediaGenerationReference, MediaGenerationResult, MediaModelDescriptor } from "./types";
import type { CompiledGenerationRequest } from "@/lib/prompt-compiler/schema";

const workflowSchema = z.object({
  modelId: z.string().min(1).max(120),
  width: z.number().int().min(128).max(1920), height: z.number().int().min(128).max(1920),
  frameRate: z.number().int().min(1).max(60), frameMultiple: z.number().int().min(1).max(32).default(4),
  frameOffset: z.number().int().min(0).max(31).default(1),
  maxDurationMs: z.number().int().min(1000).max(30000),
  aspectRatio: z.string().min(1).max(16), outputNodeId: z.string().min(1),
  nodes: z.record(z.string(), z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }).passthrough())
}).strict();
type Workflow = z.infer<typeof workflowSchema>;
const TOKENS = ["PROMPT", "NEGATIVE_PROMPT", "FIRST_FRAME", "WIDTH", "HEIGHT", "FPS", "FRAME_COUNT", "SEED"];
function substitute(value: unknown, values: Record<string, string | number>): unknown {
  if (typeof value === "string" && /^\{\{[A-Z_]+\}\}$/.test(value)) {
    const token = value.slice(2, -2);
    if (!(token in values)) throw new MediaProviderError("Unknown ComfyUI workflow placeholder: " + token, true);
    return values[token];
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,substitute(item,values)]));
  return value;
}
export function readComfyWorkflow(path: string): Workflow {
  const workflow = workflowSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!workflow.nodes[workflow.outputNodeId]) throw new MediaProviderError("ComfyUI output node is missing.", true);
  const serialized = JSON.stringify(workflow.nodes);
  for (const token of ["PROMPT", "FIRST_FRAME", "FRAME_COUNT"]) {
    if (!serialized.includes(JSON.stringify("{{" + token + "}}"))) throw new MediaProviderError("ComfyUI workflow requires {{" + token + "}}.", true);
  }
  substitute(workflow.nodes, Object.fromEntries(TOKENS.map(token => [token, "validation"])));
  return workflow;
}
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new MediaProviderError("ComfyUI media transfer failed (HTTP " + response.status + ").", response.status >= 400 && response.status < 500);
  if (Number(response.headers.get("content-length")) > limit) throw new MediaProviderError("ComfyUI media exceeds its size limit.", true);
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length;
    if (length > limit) { await reader.cancel(); throw new MediaProviderError("ComfyUI media exceeds its size limit.", true); } parts.push(item.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
/** Executes a real operator-installed ComfyUI image-to-video graph, without cloud inference charges. */
export class ComfyUIVideoAdapter implements MediaGenerationAdapter {
  readonly providerId = "comfyui";
  private readonly workflow: Workflow;
  private readonly base: string;
  constructor(baseUrl: string, workflowPath: string, private readonly apiKey?: string) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new MediaProviderError("Invalid ComfyUI base URL.", true);
    this.base = url.toString().replace(/\/$/, ""); this.workflow = readComfyWorkflow(workflowPath);
  }
  async listModels(): Promise<MediaModelDescriptor[]> {
    return [{ providerId: this.providerId, modelId: this.workflow.modelId, enabled: true, priority: 10,
      capabilities: { textToImage: false, imageEditing: false, imageToVideo: true, referenceImages: false, firstFrame: true, lastFrame: false,
        minDurationMs: 1000, maxDurationMs: this.workflow.maxDurationMs, aspectRatios: [this.workflow.aspectRatio], resolutions: [`${this.workflow.height}p`] } }];
  }
  private async request(path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await fetch(this.base + path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...(this.apiKey ? { authorization: "Bearer " + this.apiKey } : {}) }, redirect: "error", signal: AbortSignal.timeout(60000) }); }
    catch { throw new MediaProviderError("ComfyUI could not be reached. Check the GPU worker and network connection.", false); }
    if (!response.ok) throw new MediaProviderError("ComfyUI returned HTTP " + response.status + ".", response.status >= 400 && response.status < 500 && ![408,409,429].includes(response.status), response.status);
    return response;
  }
  async submit(input: { model: MediaModelDescriptor; request: CompiledGenerationRequest; references?: MediaGenerationReference[] }) {
    const { request, model } = input, w = this.workflow;
    if (model.providerId !== this.providerId || model.modelId !== w.modelId || request.mediaKind !== "VIDEO" || request.aspectRatio !== w.aspectRatio || request.generationDurationMs > w.maxDurationMs) throw new MediaProviderError("The ComfyUI workflow cannot satisfy this video request.", true);
    const frame = input.references?.find(item => item.role === "FIRST_FRAME");
    if (!frame) throw new MediaProviderError("ComfyUI requires an approved first frame.", true);
    let bytes: Uint8Array;
    if (frame.dataUri) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(frame.dataUri);
      if (!match || match[2]!.length > 14 * 1024 * 1024) throw new MediaProviderError("Invalid or oversized first frame.", true);
      bytes = Buffer.from(match[2]!, "base64");
    } else if (frame.url && /^https?:\/\//.test(frame.url)) {
      bytes = await boundedBytes(await fetch(frame.url, { redirect: "error", signal: AbortSignal.timeout(60000) }), 10 * 1024 * 1024);
    } else throw new MediaProviderError("The first frame has no usable image source.", true);
    const contentType = frame.contentType ?? "image/png";
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string,string>)[contentType];
    if (!extension || !bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) throw new MediaProviderError("Invalid or oversized first frame.", true);
    const upload = new FormData(); upload.set("image", new Blob([Buffer.from(bytes)], { type: contentType }), randomUUID() + "." + extension); upload.set("type", "input"); upload.set("overwrite", "false");
    const image = z.object({ name: z.string().min(1), subfolder: z.string().default("") }).parse(await (await this.request("/upload/image", { method: "POST", body: upload })).json());
    const name = [image.subfolder, image.name].filter(Boolean).join("/");
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw new MediaProviderError("Invalid ComfyUI image path.", true);
    const frames = Math.max(w.frameOffset + w.frameMultiple, Math.ceil((Math.ceil(request.generationDurationMs * w.frameRate / 1000) - w.frameOffset) / w.frameMultiple) * w.frameMultiple + w.frameOffset);
    const seed = Math.floor(Math.random() * 2147483647);
    const graph = substitute(w.nodes, { PROMPT: request.prompt, NEGATIVE_PROMPT: request.negativeConstraints.join("; "), FIRST_FRAME: name, WIDTH: w.width, HEIGHT: w.height, FPS: w.frameRate, FRAME_COUNT: frames, SEED: seed });
    const task = z.object({ prompt_id: z.string().uuid() }).parse(await (await this.request("/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: randomUUID() }) })).json());
    return { providerId: this.providerId, modelId: model.modelId, externalJobId: task.prompt_id,
      requestSnapshot: { workflow: graph, outputNodeId: w.outputNodeId, duration: frames / w.frameRate, seed } };
  }
  async poll(input: { model: MediaModelDescriptor; externalJobId: string }): Promise<MediaGenerationResult> {
    if (input.model.providerId !== this.providerId || input.model.modelId !== this.workflow.modelId || !z.string().uuid().safeParse(input.externalJobId).success) throw new MediaProviderError("Invalid ComfyUI task.", true);
    const history = await (await this.request("/history/" + encodeURIComponent(input.externalJobId))).json() as Record<string, { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, { gifs?: Array<{ filename: string; subfolder?: string; type?: string }>; videos?: Array<{ filename: string; subfolder?: string; type?: string }> }> }>;
    const task = history[input.externalJobId];
    if (!task) return { externalJobId: input.externalJobId, status: "QUEUED", outputs: [] };
    if (task.status?.status_str === "error") return { externalJobId: input.externalJobId, status: "FAILED", outputs: [], errorMessage: "The ComfyUI workflow failed. Inspect the GPU worker's execution log." };
    if (!task.status?.completed) return { externalJobId: input.externalJobId, status: "RUNNING", outputs: [] };
    const output = task.outputs?.[this.workflow.outputNodeId];
    const video = [...(output?.gifs ?? []), ...(output?.videos ?? [])].find(item => item.filename.toLowerCase().endsWith(".mp4"));
    if (!video || /[\\/]/.test(video.filename) || video.filename.includes("..") || (video.subfolder ?? "").split(/[\\/]/).includes("..") || (video.subfolder ?? "").startsWith("/") || !["output", "temp"].includes(video.type ?? "output")) throw new MediaProviderError("ComfyUI completed without a valid MP4 at the configured output node.", true);
    const query = new URLSearchParams({ filename: video.filename, subfolder: video.subfolder ?? "", type: video.type ?? "output" });
    const bytes = await boundedBytes(await this.request("/view?" + query), 50 * 1024 * 1024);
    return { externalJobId: input.externalJobId, status: "SUCCEEDED", outputs: [{ kind: "INLINE_BASE64", contentType: "video/mp4", base64: Buffer.from(bytes).toString("base64") }], providerSnapshot: { outputNodeId: this.workflow.outputNodeId, fileName: video.filename } };
  }
}
