import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { db } from "../src/lib/db";
import { createRenderFixture } from "./fixtures/render-project";
import { narrativePlanSchema } from "../src/lib/narrative/plan";

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
  try {
    const initialSteps = await db.wizardStepState.findMany({ where: { wizardProgress: { projectVersionId: fixture.projectVersionId } }, orderBy: { ordinal: "asc" } });
    const endpoint = `/api/projects/${fixture.projectId}/narrative`;
    const stranger = await browser.newContext();
    try {
      expect((await stranger.request.get(endpoint)).status()).toBe(401);
      const other = await signup(stranger.request, "Other director");
      otherUserId = ((await other.json()) as { user: { id: string } }).user.id;
      expect((await stranger.request.get(endpoint)).status()).toBe(404);
    } finally { await stranger.close(); }
    await page.goto(`/app/projects/${fixture.projectId}/narrative`);
    await expect(page.getByRole("heading", { name: "Give the music a story." })).toBeVisible();
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
  } finally {
    await fixture.cleanup(); await db.user.deleteMany({ where: { id: { in: [userId, ...(otherUserId?[otherUserId]:[])] } } }); await db.$disconnect();
  }
});
