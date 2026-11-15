import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AssetKind, AssetStatus, DomainVersionKind, GenerationKind, GenerationStatus } from "@prisma/client";
import { db } from "../src/lib/db";
import { getWorkspaceUsage } from "../src/lib/ops/usage-service";
import { ensurePersonalWorkspace } from "../src/lib/workspaces";

async function main() {
  const userId = randomUUID();
  const otherId = randomUUID();
  const now = new Date(Date.UTC(2026, 10, 15, 12));
  try {
    for (const id of [userId, otherId]) await db.user.create({ data: { id, email: `usage-${id}@example.test`, displayName: "Usage" } });
    const workspace = await ensurePersonalWorkspace(userId, "Usage");
    const other = await ensurePersonalWorkspace(otherId, "Other");
    const job = (workspaceId: string, kind: GenerationKind, providerKey: string, status: GenerationStatus, createdAt: Date, requestSnapshot: object = {}) =>
      db.generationJob.create({ data: { workspaceId, kind, providerKey, status, createdAt, requestSnapshot,
        startedAt: createdAt, completedAt: new Date(createdAt.getTime() + 60_000) } });
    const thisMonth = new Date(Date.UTC(2026, 10, 3));
    const lastMonth = new Date(Date.UTC(2026, 9, 20));
    await job(workspace.id, GenerationKind.IMAGE, "openai-images:initial-frame", GenerationStatus.SUCCEEDED, thisMonth);
    await job(workspace.id, GenerationKind.IMAGE, "openai-images:initial-frame", GenerationStatus.FAILED, thisMonth);
    await job(workspace.id, GenerationKind.VIDEO, "runway:video-clip", GenerationStatus.SUCCEEDED, thisMonth, { request: { generationDurationMs: 8000 } });
    await job(workspace.id, GenerationKind.RENDER, "ffmpeg:finish-export", GenerationStatus.SUCCEEDED, lastMonth);
    await job(workspace.id, GenerationKind.TEXT, "openai-responses:treatment", GenerationStatus.SUCCEEDED, new Date(Date.UTC(2025, 0, 1)));
    await job(other.id, GenerationKind.IMAGE, "openai-images:initial-frame", GenerationStatus.SUCCEEDED, thisMonth);
    const node = await db.domainVersionNode.create({ data: { kind: DomainVersionKind.ASSET } });
    await db.asset.create({ data: { workspaceId: workspace.id, kind: AssetKind.OTHER, versions: { create: {
      nodeId: node.id, versionNumber: 1, status: AssetStatus.READY, storageKey: "usage-smoke/" + randomUUID(), contentType: "image/png", byteSize: BigInt(4096) } } } });

    process.env.USAGE_MONTHLY_BUDGET_USD = "0.4";
    const usage = await getWorkspaceUsage({ userId, displayName: "Usage", now });
    assert.deepEqual(usage.months.map(month => month.month), ["2026-11", "2026-10"], "Only the last six months are reported.");
    assert.deepEqual({ ...usage.months[0], computeSeconds: 0 }, { month: "2026-11", jobs: 3, succeeded: 2, failed: 1, paidJobs: 3,
      estimatedUsd: 0.44, unpricedJobs: 0, computeSeconds: 0 });
    assert.equal(usage.months[0]!.computeSeconds, 180);
    assert.equal(usage.months[1]!.estimatedUsd, 0);
    assert.equal(usage.storage.bytes, 4096);
    assert.equal(usage.quotas.find(item => item.key === "monthlyBudgetUsd")?.state, "exceeded");
    assert.equal(usage.quotas.find(item => item.key === "monthlyJobLimit")?.state, "unset");
    assert.equal(usage.recent.length, 5, "Other workspaces never leak into the report.");
    assert.equal(usage.recent.find(item => item.providerKey === "runway:video-clip")?.estimatedUsd, 0.4);
    console.log("Usage smoke test passed (monthly SQL aggregation, estimates, storage, quotas, workspace isolation).");
  } finally {
    delete process.env.USAGE_MONTHLY_BUDGET_USD;
    const workspaces = await db.workspace.findMany({ where: { memberships: { some: { userId: { in: [userId, otherId] } } } }, select: { id: true } });
    const ids = workspaces.map(item => item.id);
    await db.generationJobEvent.deleteMany({ where: { job: { workspaceId: { in: ids } } } });
    await db.generationJob.deleteMany({ where: { workspaceId: { in: ids } } });
    const assets = await db.asset.findMany({ where: { workspaceId: { in: ids } }, select: { id: true } });
    await db.assetVersion.deleteMany({ where: { assetId: { in: assets.map(item => item.id) } } });
    await db.asset.deleteMany({ where: { workspaceId: { in: ids } } });
    await db.workspace.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }).catch(() => undefined);
    await db.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
