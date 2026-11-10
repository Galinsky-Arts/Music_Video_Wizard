import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { db } from "../src/lib/db";
import { createRenderFixture } from "./fixtures/render-project";
import { narrativePlanSchema } from "../src/lib/narrative/plan";
import { runMediaProcess } from "../src/lib/media/process";

async function signup(request: APIRequestContext, name: string) {
  const data = { name, email: `story-${randomUUID()}@example.test`, password: "Narrative-Test-Password-2026!" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.post("/api/auth/sign-up/email", { data });
    if (response.status() !== 429) { expect(response.ok(), `Signup HTTP ${response.status()}`).toBe(true); return response; }
    // Respect the production signup limit when the complete browser suite shares one IP.
    const seconds = Math.max(1, Math.min(60, Number(response.headers()["retry-after"]) || 60));
    await new Promise(resolve=>setTimeout(resolve,seconds*1000));
  }
  throw new Error("Signup rate limit did not clear within the test window.");
}

test("a director can version and export a narrative without inventing generation or changing the edit", async ({ page, browser }) => {
  test.setTimeout(180000);
  const account = await signup(page.request, "Narrative director");
  expect(account.ok()).toBe(true); const userId = ((await account.json()) as { user: { id: string } }).user.id;
  const fixture = await createRenderFixture(userId, true, 30); let otherUserId: string | undefined;
  const directory = await mkdtemp(join(tmpdir(), "mvw-local-browser-"));
  try {
    const initialSteps = await db.wizardStepState.findMany({ where: { wizardProgress: { projectVersionId: fixture.projectVersionId } }, orderBy: { ordinal: "asc" } });
    const endpoint = `/api/projects/${fixture.projectId}/narrative`;
    const stranger = await browser.newContext();
    try {
      expect((await stranger.request.get(endpoint)).status()).toBe(401);
      expect((await stranger.request.get(`${endpoint}/audio?version=${fixture.audioAssetVersionId}`)).status()).toBe(401);
      const other = await signup(stranger.request, "Other director");
      otherUserId = ((await other.json()) as { user: { id: string } }).user.id;
      expect((await stranger.request.get(endpoint)).status()).toBe(404);
      expect((await stranger.request.get(`${endpoint}/audio?version=${fixture.audioAssetVersionId}`)).status()).toBe(404);
    } finally { await stranger.close(); }
    await page.goto(`/app/projects/${fixture.projectId}/narrative`);
    await expect(page.getByRole("heading", { name: "Give the music a story." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create video on this device" })).toBeVisible();
    await expect(page.getByText(/GB download on first use/)).toContainText("11.5 GB");
    await page.getByLabel("Story title").fill("Controlled Chaos: an original fan mission");
    await page.getByLabel("James T. Kirk", { exact: true }).fill("Kirk wears the same gold uniform and has a torn right sleeve after the escape attempt.");
    await page.getByRole("button", { name: "Save narrative plan", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Story version 1 saved");
    const initial = await (await page.request.get(endpoint)).json();
    const plan = narrativePlanSchema.parse(initial.plan);
    expect(plan.shots.every(s=>s.prompt.includes("torn right sleeve"))).toBe(true);
    expect(plan.durationMs).toBe(30000);
    expect((await page.request.post(endpoint, { data: { expectedVersionId: null, plan } })).status()).toBe(409);
    expect((await page.request.post(endpoint, { data: "x".repeat(256*1024+1), headers: { "content-type": "application/json" } })).status()).toBe(413);
    expect(await db.generationJob.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(await db.timeline.count({ where: { projectId: fixture.projectId } })).toBe(0);
    const steps = await db.wizardStepState.findMany({ where: { wizardProgress: { projectVersionId: fixture.projectVersionId } }, orderBy: { ordinal: "asc" } });
    expect(steps).toEqual(initialSteps);
    await page.reload(); await expect(page.getByLabel("Story title")).toHaveValue(plan.title);
    const promise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download story and shot prompts" }).click();
    const download = await promise, bytes = await readFile((await download.path())!);
    expect(narrativePlanSchema.parse(JSON.parse(bytes.toString())).title).toBe(plan.title);
    const version = await db.assetVersion.findUniqueOrThrow({ where: { id: initial.versionId } });
    expect(version.metadata).toMatchObject({ origin: "DIRECTOR_AUTHORED", role: "narrative-plan", sourceProjectVersionId: fixture.projectVersionId });
    expect(version.checksumSha256).toBe(createHash("sha256").update(JSON.stringify(plan)).digest("hex"));

    const soundtrack = await page.request.get(`${endpoint}/audio?version=${fixture.audioAssetVersionId}`);
    expect(soundtrack.ok()).toBe(true); expect(soundtrack.headers()["cache-control"]).toBe("private, no-store");
    const audioVersion = await db.assetVersion.findUniqueOrThrow({ where: { id: fixture.audioAssetVersionId } });
    expect(createHash("sha256").update(await soundtrack.body()).digest("hex")).toBe(audioVersion.checksumSha256);
    expect((await page.request.get(`${endpoint}/audio?version=${randomUUID()}`)).status()).toBe(409);

    // Inference is explicitly mocked. The actual browser WebCodecs assembler and
    // protected soundtrack endpoint run end to end; no test downloads 11.5 GB.
    const clipPath = join(directory, "synthetic-take.mp4");
    await runMediaProcess({ executable: "ffmpeg", args: ["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=160x96:r=16:d=5.0625", "-threads", "1", "-y", clipPath], signal: AbortSignal.timeout(10000), description: "Synthetic local inference fixture" });
    await page.addInitScript(({ clip }) => {
      Object.defineProperty(navigator, "gpu", { configurable: true, value: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) } });
      Object.defineProperty(navigator.storage, "estimate", { configurable: true, value: async () => ({ quota: 100e9, usage: 0 }) });
      const ActualWorker = window.Worker;
      const fixtureState = { calls: 0 };
      Object.defineProperty(window, "__localInferenceFixture", { value: fixtureState });
      class InferenceFixture {
        onmessage: ((event: { data: object }) => void) | null = null;
        onerror = null;
        stopped = false;
        terminate() { this.stopped = true; }
        postMessage(data: { type: string; hidden?: Uint16Array }) {
          fixtureState.calls++;
          const bytes = Uint8Array.from(atob(clip), c => c.charCodeAt(0));
          setTimeout(() => { if (!this.stopped) this.onmessage?.({ data: { type: "done", hidden: data.hidden ?? new Uint16Array(4096), latent: new Float32Array(1), bytes } }); }, 20);
        }
      }
      window.Worker = class extends ActualWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (String(url).endsWith("/stage-worker.js")) return new InferenceFixture() as unknown as Worker;
          super(url, options);
        }
      };
    }, { clip: (await readFile(clipPath)).toString("base64") });
    await page.reload();
    const fullButton = page.getByRole("button", { name: "Generate full music video", exact: true });
    await expect(fullButton).toBeEnabled(); await fullButton.click();
    const movieLink = page.getByRole("link", { name: "Download music video", exact: true });
    await expect(movieLink).toBeVisible({ timeout: 90000 });
    const movieDownloadPromise = page.waitForEvent("download"); await movieLink.click();
    const movie = await movieDownloadPromise, moviePath = join(directory, "movie.mp4"); await movie.saveAs(moviePath);
    const probe = JSON.parse(await runMediaProcess({ executable: "ffprobe", args: ["-v", "error", "-show_streams", "-of", "json", moviePath], captureStdout: true, signal: AbortSignal.timeout(10000), description: "Verify real browser assembly" }));
    expect(probe.streams.find((s: { codec_type: string }) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 832, height: 480, nb_frames: "720", duration: "30.000000" });
    expect(Number(probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio").duration)).toBeCloseTo(30, 1);
    await runMediaProcess({ executable: "ffmpeg", args: ["-v", "error", "-i", moviePath, "-f", "null", "-"], signal: AbortSignal.timeout(30000), description: "Decode complete browser movie" });
    await page.reload(); await expect(page.getByText(`${plan.shots.length}/${plan.shots.length} shots kept on this device.`, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Generate full music video", exact: true }).click();
    await expect(movieLink).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => (window as unknown as { __localInferenceFixture: { calls: number } }).__localInferenceFixture.calls)).toBe(0);
    expect(await db.generationJob.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(await db.timeline.count({ where: { projectId: fixture.projectId } })).toBe(0);
  } finally {
    await fixture.cleanup(); await db.user.deleteMany({ where: { id: { in: [userId, ...(otherUserId?[otherUserId]:[])] } } }); await db.$disconnect(); await rm(directory, { recursive: true, force: true });
  }
});
