import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createRenderFixture } from "./fixtures/render-project";
import { db } from "../src/lib/db";
import { registerFinalMasterRenderHandler } from "../src/lib/finish-export/register";
import { handleFinalMasterRender } from "../src/lib/finish-export/handler";
import { drainGenerationQueueBatch } from "../src/lib/jobs/worker";
import { stopJobQueue } from "../src/lib/jobs/queue";

// Paid-provider calls are deliberately absent. Planning/generation acceptance is separate.
test("locked edit renders through the durable queue and downloads a verified master", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const marker = Date.now() + "-" + Math.random().toString(16).slice(2);
  const account = await page.request.post("/api/auth/sign-up/email", { data: {
    name: "Final export E2E", email: `export-${marker}@example.test`, password: "Browser-E2E-Password-2026!"
  } });
  expect(account.ok()).toBe(true);
  const { user } = await account.json() as { user: { id: string } };
  const fixture = await createRenderFixture(user.id);
  try {
    const endpoint = `/api/projects/${fixture.projectId}/finish-export`;
    await page.goto(`/app/projects/${fixture.projectId}/wizard?step=finish-export`);
    await expect(page.getByRole("heading", { name: "Finish & export", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Prepare.*manifest/i }).click();
    await expect(page.getByRole("button", { name: /Render final master/i })).toBeEnabled();
    const state = await (await page.request.get(endpoint)).json() as { wizardRevision: number };
    // Two independent submissions with the SAME revision must not dispatch twice.
    const responses = await Promise.all([0, 1].map(() => page.request.post(endpoint + "/render", {
      data: { expectedWizardRevision: state.wizardRevision }
    })));
    expect(responses.filter(response => response.status() === 202)).toHaveLength(1);
    expect(responses.filter(response => [400, 409].includes(response.status()))).toHaveLength(1);
    const queued = await responses.find(response => response.status() === 202)!.json() as { jobId: string };
    expect(await db.generationJob.count({ where: { projectId: fixture.projectId } })).toBe(1);
    // Reconnect the queue before execution to prove the queued work survives producer shutdown.
    await stopJobQueue();
    registerFinalMasterRenderHandler();
    await page.reload();
    await drainGenerationQueueBatch(16);
    const job = await db.generationJob.findUniqueOrThrow({ where: { id: queued.jobId } });
    expect(job.status, job.errorMessage ?? "render status").toBe("SUCCEEDED");
    const link = page.getByRole("link", { name: "Download MP4", exact: true });
    await expect(link).toBeVisible({ timeout: 20_000 });
    const downloadPromise = page.waitForEvent("download");
    await link.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("music-video-master-v1.mp4");
    const bytes = await readFile((await download.path())!);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const master = await db.assetVersion.findUniqueOrThrow({ where: { id: job.id } });
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(master.checksumSha256);
    expect(master).toMatchObject({ width: 160, height: 90, frameRate: 24, durationMs: 3000 });
    expect(master.metadata).toMatchObject({ verification: { frameCount: 72, audioDurationMs: 3000 } });
    // Handler replay reuses the persisted output rather than creating another master.
    const replay = await handleFinalMasterRender(job, { signal: new AbortController().signal, reportProgress: async () => undefined });
    expect(replay).toMatchObject({ reused: true, assetVersionId: master.id });
    expect(await db.assetVersion.count({ where: { assetId: master.assetId } })).toBe(1);
    await page.getByRole("button", { name: "Lock Finish & Export" }).click();
    await expect(page.getByRole("button", { name: /Finish & export LOCKED/ })).toBeVisible();
    await page.reload();
    await expect(link).toBeVisible();
    const stranger = await browser.newContext();
    let otherUserId: string | undefined;
    try {
      const denied = await stranger.request.get(endpoint);
      expect(denied.status()).toBe(401);
      const otherAccount = await stranger.request.post("/api/auth/sign-up/email", { data: {
        name: "Other owner", email: `other-${marker}@example.test`, password: "Browser-E2E-Password-2026!"
      } });
      expect(otherAccount.ok()).toBe(true);
      otherUserId = ((await otherAccount.json()) as { user: { id: string } }).user.id;
      const other = await stranger.request.get(endpoint);
      expect(other.status()).toBeGreaterThanOrEqual(400);
      expect(await other.text()).not.toContain(master.storageKey);
      const signed = new URL((await link.getAttribute("href"))!);
      const signedResponse = await page.request.get(signed.toString());
      expect(signedResponse.headers()["content-disposition"]).toContain("attachment;");
      signed.searchParams.set("download", "tampered.mp4");
      expect((await page.request.get(signed.toString())).status()).toBe(403);
    } finally {
      await stranger.close();
      if (otherUserId) await db.user.deleteMany({ where: { id: otherUserId } });
    }
  } finally {
    await stopJobQueue();
    await fixture.cleanup();
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
});
