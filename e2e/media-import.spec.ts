import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { DomainVersionKind } from "@prisma/client";
import { db } from "../src/lib/db";
import { createRenderFixture } from "./fixtures/render-project";
import { runMediaProcess } from "../src/lib/media/process";

test("artists can import frames and clips with providers disabled", async ({ page }) => {
  test.setTimeout(120000);
  const account = await page.request.post("/api/auth/sign-up/email", { data: { name: "Import artist", email: `import-${randomUUID()}@example.test`, password: "Import-Test-Password-2026!" } });
  expect(account.ok()).toBe(true);
  const userId = ((await account.json()) as { user: { id: string } }).user.id;
  const fixture = await createRenderFixture(userId);
  const directory = await mkdtemp(join(tmpdir(), "import-browser-"));
  try {
    const storyboard = await db.shotVersion.findFirstOrThrow({ where: { shot: { projectId: fixture.projectId } }, orderBy: { createdAt: "asc" } });
    const sequence = await db.sequence.create({ data: { projectId: fixture.projectId, versions: { create: {
      versionNumber: 1, node: { create: { kind: "SEQUENCE" } }, title: "Synthetic import sequence", lifecycle: "LOCKED" } } }, include: { versions: true } });
    const sequenceVersion = sequence.versions[0]!;
    await db.sequenceVersionShot.create({ data: { sequenceVersionId: sequenceVersion.id, shotVersionId: storyboard.id, position: 0 } });
    await db.projectVersionSequence.create({ data: { projectVersionId: fixture.projectVersionId, sequenceVersionId: sequenceVersion.id, position: 0 } });
    await db.shotVersion.update({ where: { id: storyboard.id }, data: { plannedStartMs: 0, plannedEndMs: 1000 } });
    const specification = await db.shotVersion.create({ data: { shot: { connect: { id: storyboard.shotId } }, node: { create: { kind: DomainVersionKind.SHOT } }, versionNumber: 2, lifecycle: "LOCKED", structuredSpec: {
      schemaVersion: 1, stage: "SHOT_SPECIFICATION", sourceStoryboardShotVersionId: storyboard.id, sourceStoryboardShotNodeId: storyboard.nodeId,
      sourceSequenceVersionId: sequenceVersion.id, sourceSequenceNodeId: sequenceVersion.nodeId, sourceSequencePosition: 0, sourceShotPosition: 0,
      sourceCreativeLanguageVersionId: randomUUID(), generationJobId: randomUUID(), origin: "GENERATED",
      composition: "Synthetic test composition", framing: "Wide", cameraAngle: "Level", lens: "35 mm", lighting: "Soft", colorTreatment: "Blue",
      cameraMotion: "Static", subjectMotion: "Still", performanceDirection: "None", focusAndDepth: "Deep", continuityNotes: "Stable", wardrobeNotes: "", propsNotes: "",
      transitionIn: "", transitionOut: "CUT", generationHandlesMs: 0, requiredElements: ["Color"], exclusions: ["Text"], productionNotes: "Test-only synthetic provenance" } } });
    await db.wizardStepState.updateMany({ where: { wizardProgress: { projectVersionId: fixture.projectVersionId }, stepKey: "shot-specifications" }, data: { status: "COMPLETED", lockedAt: new Date() } });
    const ffmpeg = process.env.VIDEO_RENDER_FFMPEG ?? "ffmpeg";
    const png = join(directory, "frame.png"); const mp4 = join(directory, "clip.mp4");
    const run = (args: string[]) => runMediaProcess({ executable: ffmpeg, args, signal: AbortSignal.timeout(10000), description: "Import fixture" });
    await run(["-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=160x90", "-frames:v", "1", "-threads", "1", "-y", png]);
    await run(["-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=160x90:r=24:d=2", "-y", mp4]);
    await page.goto(`/app/projects/${fixture.projectId}/wizard?step=initial-frames`);
    await page.getByLabel("Import your own frame").setInputFiles(png);
    await page.getByRole("button", { name: "Import frame", exact: true }).click();
    await expect(page.getByRole("button", { name: "Lock Initial Frames" })).toBeEnabled();
    const framesResponse = await page.request.get(`/api/projects/${fixture.projectId}/initial-frames`);
    const frames = await framesResponse.json() as { frames: Array<{ assetVersionId: string }>; wizardRevision: number };
    const imported = await db.assetVersion.findUniqueOrThrow({ where: { id: frames.frames[0]!.assetVersionId } });
    expect(imported.metadata).toMatchObject({ origin: "import", generationJobId: null, providerId: "user-import" });
    expect(await db.generationJob.count({ where: { projectId: fixture.projectId } })).toBe(0);
    await page.getByRole("button", { name: "Lock Initial Frames" }).click();
    await expect(page.getByRole("button", { name: /Initial frames LOCKED/ })).toBeVisible();
    await page.goto(`/app/projects/${fixture.projectId}/wizard?step=video-clips`);
    await page.getByLabel("Import your own clip").setInputFiles(mp4);
    await page.getByRole("button", { name: "Import clip", exact: true }).click();
    await expect(page.getByRole("button", { name: "Lock Video Clips" })).toBeEnabled();
    await page.getByRole("button", { name: "Lock Video Clips" }).click();
    await expect(page.getByRole("button", { name: /Video clips LOCKED/ })).toBeVisible();
    const state = await (await page.request.get(`/api/projects/${fixture.projectId}/video-clips`)).json() as { wizardRevision: number; clips: Array<{ assetVersionId: string }> };
    const clip = await db.assetVersion.findUniqueOrThrow({ where: { id: state.clips[0]!.assetVersionId } });
    expect(clip).toMatchObject({ durationMs: 2000, width: 160, height: 90, frameRate: 24 });
    const denied = await page.request.post(`/api/projects/${fixture.projectId}/media-import`, { multipart: { kind: "video", shotSpecificationVersionId: specification.id,
      expectedWizardRevision: String(state.wizardRevision), media: { name: "clip.mp4", mimeType: "video/mp4", buffer: await readFile(mp4) } } });
    expect(denied.status()).toBe(409);
    await expect(page.getByText(/Imported/).first()).toBeVisible();
  } finally {
    await fixture.cleanup(); await db.user.deleteMany({ where: { id: userId } }); await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
