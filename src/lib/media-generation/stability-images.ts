import { z } from "zod";
import type { CompiledGenerationRequest } from "@/lib/prompt-compiler/schema";
import { MediaProviderError } from "./errors";
import type { MediaGenerationAdapter, MediaGenerationSubmission, MediaModelDescriptor } from "./types";
const ORIGIN = "https://api.stability.ai";
const RATIOS = ["16:9","1:1","21:9","2:3","3:2","4:5","5:4","9:16","9:21"];
function httpError(status: number) {
  return new MediaProviderError(`Stability API returned HTTP ${status}.`, status >= 400 && status < 500 && ![408,409,429].includes(status), status);
}
async function stabilityRequest(key: string, path: string, init: RequestInit) {
  let response: Response;
  try { response = await fetch(ORIGIN + path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: "Bearer " + key },
    redirect: "error", signal: AbortSignal.timeout(120000) }); }
  catch { throw new MediaProviderError("The Stability API could not be reached.",false); }
  if (!response.ok) throw httpError(response.status);
  return response;
}
/** Read-only authentication check; never calls a media-generation endpoint. */
export async function getStabilityCreditBalance(key: string) {
  const response = await stabilityRequest(key,"/v1/user/balance",{method:"GET",headers:{accept:"application/json"}});
  return z.object({ credits: z.number().finite().nonnegative() }).parse(await response.json());
}
export class StabilityImageAdapter implements MediaGenerationAdapter {
  readonly providerId = "stability-images";
  constructor(private readonly apiKey: string) {}
  async listModels(): Promise<MediaModelDescriptor[]> {
    return [{ providerId: this.providerId, modelId: "stable-image-core", enabled: true, priority: 10,
      capabilities: { textToImage: true, imageEditing: false, imageToVideo: false, referenceImages: false, firstFrame: false, lastFrame: false,
        minDurationMs: 1, maxDurationMs: Number.MAX_SAFE_INTEGER, aspectRatios: [...RATIOS], resolutions: [] } }];
  }
  async submit(input: { model: MediaModelDescriptor; request: CompiledGenerationRequest }): Promise<MediaGenerationSubmission> {
    const r = input.request;
    if (input.model.providerId !== this.providerId || input.model.modelId !== "stable-image-core" || r.mediaKind !== "IMAGE") throw new MediaProviderError("Stability Core accepts image requests only.",true);
    if (!RATIOS.includes(r.aspectRatio)) throw new MediaProviderError("The requested aspect ratio is not supported by Stability Core.",true);
    const negatives = r.negativeConstraints.join("; ");
    if (!r.prompt.trim() || r.prompt.length > 10000 || negatives.length > 10000) throw new MediaProviderError("Stability prompts must contain at most 10,000 characters.",true);
    const snapshot = { prompt: r.prompt, negative_prompt: negatives, aspect_ratio: r.aspectRatio, output_format: "png" };
    const form = new FormData(); for (const [key,value] of Object.entries(snapshot)) if (value) form.set(key,value);
    const response = await stabilityRequest(this.apiKey,"/v2beta/stable-image/generate/core",{ method:"POST",headers:{accept:"image/*"},body:form });
    if (response.headers.get("finish-reason") === "CONTENT_FILTERED") throw new MediaProviderError("Stability filtered this image request. Revise the prompt before trying again.",true);
    const limit = 20 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit || !response.body) throw new MediaProviderError("Stability returned an invalid or oversized image.",true);
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > limit) { await reader.cancel(); throw new MediaProviderError("Stability image exceeds 20 MB.",true); } parts.push(part.value); }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(parts);
    if (bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii",12,16) !== "IHDR") throw new MediaProviderError("Stability returned no usable PNG image.",true);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192) throw new MediaProviderError("Stability returned invalid image dimensions.",true);
    return { providerId: this.providerId, modelId: input.model.modelId, externalJobId: null, requestSnapshot: snapshot,
      immediateResult: { externalJobId: null, status: "SUCCEEDED", outputs: [{ kind: "INLINE_BASE64", contentType: "image/png", base64: bytes.toString("base64") }],
        providerSnapshot: { seed: response.headers.get("seed"), finishReason: response.headers.get("finish-reason"), width, height } } };
  }
  async poll(): Promise<never> { throw new MediaProviderError("Stability Core image generation is synchronous.",true); }
}
