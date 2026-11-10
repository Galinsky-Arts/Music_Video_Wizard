import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironment } from "@/lib/env";
import { getConfiguredMediaGenerationAdapters } from "./factory";
import { ComfyUIVideoAdapter, readComfyWorkflow } from "./comfyui-video";
import type { CompiledGenerationRequest } from "@/lib/prompt-compiler/schema";
const taskId = "11111111-1111-4111-8111-111111111111";
const workflow = { modelId: "test-installed-graph-v1", width: 768, height: 432, frameRate: 16,
  maxDurationMs: 10000, aspectRatio: "16:9", outputNodeId: "5", nodes: {
    "1": { class_type: "LoadImage", inputs: { image: "{{FIRST_FRAME}}" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "{{NEGATIVE_PROMPT}}" } },
    "4": { class_type: "SyntheticTestOnly", inputs: { length: "{{FRAME_COUNT}}", width: "{{WIDTH}}", height: "{{HEIGHT}}", seed: "{{SEED}}" } },
    "5": { class_type: "SyntheticTestOnlyOutput", inputs: { frame_rate: "{{FPS}}" } }
  } };
const request = { mediaKind: "VIDEO", generationDurationMs: 5000, aspectRatio: "16:9",
  prompt: 'Spock observes the anomaly. "Quoted text" {{SEED}} stays literal.', negativeConstraints: ["No extra characters"] } as CompiledGenerationRequest;
let directory: string, path: string;
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "comfy-test-")); path = join(directory, "workflow.json"); writeFileSync(path, JSON.stringify(workflow)); });
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
describe("ComfyUI local video adapter", () => {
  it("is discoverable through the production provider factory only when selected", async () => {
    const base = { NODE_ENV: "test" as const, DATABASE_URL: "postgresql://localhost/test", BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef", BETTER_AUTH_URL: "http://localhost:3000", ASSET_STORAGE_BUCKET: "test", COMFYUI_BASE_URL: "http://127.0.0.1:8188", COMFYUI_WORKFLOW_PATH: path };
    expect(getConfiguredMediaGenerationAdapters(getEnvironment(base))).toHaveLength(0);
    const adapters = getConfiguredMediaGenerationAdapters(getEnvironment({...base,VIDEO_GENERATION_PROVIDER:"comfyui"}));
    expect(adapters.map(a=>a.providerId)).toEqual(["comfyui"]);
    expect((await adapters[0]!.listModels())[0]!.capabilities.imageToVideo).toBe(true);
  });

  it("uploads an approved frame and submits a real graph with typed values and frame padding", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ name: "approved.png", subfolder: "" })).mockResolvedValueOnce(json({ prompt_id: taskId }));
    const adapter = new ComfyUIVideoAdapter("https://gpu.example.test", path, "private-worker-key");
    const model = (await adapter.listModels())[0]!;
    const result = await adapter.submit({ model, request, references: [{ role: "FIRST_FRAME", contentType: "image/png", dataUri: "data:image/png;base64,aW1hZ2U=" }] });
    expect(fetch.mock.calls[0]![0]).toBe("https://gpu.example.test/upload/image");
    expect(fetch.mock.calls[0]![1]?.body).toBeInstanceOf(FormData);
    const body = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
    expect(body.prompt["2"].inputs.text).toBe(request.prompt);
    expect(body.prompt["4"].inputs).toMatchObject({ length: 81, width: 768, height: 432 });
    expect(result).toMatchObject({ externalJobId: taskId, requestSnapshot: { duration: 81 / 16 } });
    expect(JSON.stringify(result)).not.toContain("private-worker-key");
    expect(fetch.mock.calls[1]![1]?.redirect).toBe("error");
  });
  it("rejects unsupported duration and missing references before submitting", async () => {
    const fetch = vi.spyOn(globalThis, "fetch"); const a = new ComfyUIVideoAdapter("http://127.0.0.1:8188", path); const model = (await a.listModels())[0]!;
    await expect(a.submit({ model, request: { ...request, generationDurationMs: 11000 } })).rejects.toThrow(/cannot satisfy/);
    await expect(a.submit({ model, request })).rejects.toThrow(/first frame/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fetches completed MP4 bytes with worker auth without exposing the private endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ [taskId]: { status: { completed: true }, outputs: { "5": { gifs: [{ filename: "movie.mp4", subfolder: "clips", type: "output" }] } } } })).mockResolvedValueOnce(new Response("video-bytes", { headers: { "content-type": "video/mp4" } }));
    const a = new ComfyUIVideoAdapter("https://gpu.example.test", path, "private-worker-key"); const result = await a.poll({ model: (await a.listModels())[0]!, externalJobId: taskId });
    expect(result).toMatchObject({ status: "SUCCEEDED", outputs: [{ kind: "INLINE_BASE64", base64: Buffer.from("video-bytes").toString("base64") }] });
    expect(fetch.mock.calls[1]![0]).toContain("/view?filename=movie.mp4&subfolder=clips&type=output");
    expect(fetch.mock.calls[1]![1]?.headers).toMatchObject({ authorization: "Bearer private-worker-key" });
    expect(JSON.stringify(result)).not.toContain("gpu.example.test");
  });
  it("does not mistake an empty history or failed graph for generated video", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ [taskId]: { status: { status_str: "error", completed: false } } }));
    const a = new ComfyUIVideoAdapter("http://127.0.0.1:8188", path); const model = (await a.listModels())[0]!;
    expect((await a.poll({ model, externalJobId: taskId })).status).toBe("QUEUED");
    expect((await a.poll({ model, externalJobId: taskId })).status).toBe("FAILED");
  });
  it("rejects output traversal, wrong file types and oversized media", async () => {
    const fetch = vi.spyOn(globalThis, "fetch"); const a = new ComfyUIVideoAdapter("http://127.0.0.1:8188", path); const model = (await a.listModels())[0]!;
    for (const file of [{ filename: "../private.mp4" }, { filename: "image.png" }, { filename: "movie.mp4", subfolder: "../input" }]) {
      fetch.mockResolvedValueOnce(json({ [taskId]: { status: { completed: true }, outputs: { "5": { videos: [file] } } } }));
      await expect(a.poll({ model, externalJobId: taskId })).rejects.toThrow(/valid MP4/);
    }
    fetch.mockResolvedValueOnce(json({ [taskId]: { status: { completed: true }, outputs: { "5": { videos: [{ filename: "movie.mp4" }] } } } })).mockResolvedValueOnce(new Response("x", { headers: { "content-length": String(51 * 1024 * 1024) } }));
    await expect(a.poll({ model, externalJobId: taskId })).rejects.toThrow(/size limit/);
  });
  it("requires explicit workflow placeholders and a valid output node", () => {
    writeFileSync(path, JSON.stringify({ ...workflow, outputNodeId: "missing" })); expect(() => readComfyWorkflow(path)).toThrow(/output node/);
    writeFileSync(path, JSON.stringify({ ...workflow, nodes: { "5": { class_type: "Output", inputs: {} } } })); expect(() => readComfyWorkflow(path)).toThrow(/requires/);
  });
  it("treats rate limits as retryable and invalid graph responses as permanent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({}, 400));
    const a = new ComfyUIVideoAdapter("http://127.0.0.1:8188", path); const model = (await a.listModels())[0]!;
    await expect(a.poll({ model, externalJobId: taskId })).rejects.toMatchObject({ permanent: false, status: 429 });
    await expect(a.poll({ model, externalJobId: taskId })).rejects.toMatchObject({ permanent: true, status: 400 });
  });
});
