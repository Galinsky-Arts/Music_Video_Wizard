import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { db } from "../src/lib/db";
import { createRenderFixture } from "./fixtures/render-project";
import { runMediaProcess } from "../src/lib/media/process";
import { registerFinalMasterRenderHandler } from "../src/lib/finish-export/register";
import { drainGenerationQueueBatch } from "../src/lib/jobs/worker";
import { stopJobQueue } from "../src/lib/jobs/queue";

test("a complete local assembly reaches verified export without invented planning", async ({ page, browser }) => {
  test.setTimeout(120000);
  const account = await page.request.post("/api/auth/sign-up/email", { data: {
    name: "Local editor", email: `assembly-${randomUUID()}@example.test`, password: "Assembly-Test-Password-2026!"
  } });
  expect(account.ok()).toBe(true);
  const userId = ((await account.json()) as { user: { id: string } }).user.id;
  const fixture = await createRenderFixture(userId, true);
  const directory = await mkdtemp(join(tmpdir(), "assembly-browser-"));
  try {
    const clip = join(directory, "local-edit.mp4");
    await runMediaProcess({ executable: process.env.VIDEO_RENDER_FFMPEG ?? "ffmpeg", args: ["-v", "error", "-f", "lavfi", "-i", "color=c=purple:s=160x90:r=24:d=3", "-threads", "1", "-y", clip], signal: AbortSignal.timeout(10000), description: "Local assembly fixture" });
    const endpoint = `/api/projects/${fixture.projectId}/assembly`;
    const stranger = await browser.newContext();
    expect((await stranger.request.post(endpoint)).status()).toBe(401);
    await stranger.close();
    await page.goto(`/app/projects/${fixture.projectId}/assembly`);
    await page.getByLabel("Complete visual edit").setInputFiles(clip);
    await page.getByRole("button", { name: "Import visual edit", exact: true }).click();
    await expect(page).toHaveURL(/step=refinement/);
    await expect(page.getByRole("button", { name: "Complete Refinement", exact: true })).toBeEnabled();
    const asset = await db.assetVersion.findFirstOrThrow({ where: { asset: { projectId: fixture.projectId, kind: "GENERATED_VIDEO" } } });
    expect(asset.metadata).toMatchObject({ origin: "import", generationJobId: null, role: "imported-assembly" });
    const progress = await db.wizardProgress.findUniqueOrThrow({ where: { projectVersionId: fixture.projectVersionId }, include: { steps: true } });
    expect(progress.steps.find(step => step.stepKey === "concepts")?.status).toBe("NOT_STARTED");
    expect(await db.generationJob.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect((await page.request.post(endpoint, { multipart: { expectedWizardRevision: String(progress.revision), height: "720", media: { name: "edit.mp4", mimeType: "video/mp4", buffer: await readFile(clip) } } })).status()).toBe(409);
    await page.getByRole("button", { name: "Complete Refinement", exact: true }).click();
    await expect(page.getByRole("button", { name: "Lock Refinement", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Lock Refinement", exact: true }).click();
    await expect(page.getByRole("button", { name: /Refinement LOCKED/ })).toBeVisible();
    await page.goto(`/app/projects/${fixture.projectId}/wizard?step=finish-export`);
    await page.getByRole("button", { name: /Prepare.*manifest/i }).click();
    await expect(page.getByRole("button", { name: /Render final master/i })).toBeEnabled();
    await page.getByRole("button", { name: /Render final master/i }).click();
    registerFinalMasterRenderHandler();
    await expect.poll(() => db.generationJob.count({ where: { projectId: fixture.projectId } })).toBe(1);
    await drainGenerationQueueBatch(16);
    const job = await db.generationJob.findFirstOrThrow({ where: { projectId: fixture.projectId } });
    expect(job.status, job.errorMessage ?? "render status").toBe("SUCCEEDED");
    await expect(page.getByRole("link", { name: "Download MP4", exact: true })).toBeVisible({ timeout: 20000 });
    const master = await db.assetVersion.findUniqueOrThrow({ where: { id: job.id } });
    expect(master).toMatchObject({ durationMs: 3000, width: 1280, height: 720 });
    expect(master.metadata).toMatchObject({ verification: { frameCount: 72, audioDurationMs: 3000 } });
  } finally {
    await stopJobQueue(); await fixture.cleanup(); await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect(); await rm(directory, { recursive: true, force: true });
  }
});
