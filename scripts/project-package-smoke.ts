import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { AssetKind, AssetStatus, DomainVersionKind } from "@prisma/client";
import { db } from "../src/lib/db";
import { createProjectWithAudio } from "../src/lib/projects/create-project";
import {
  prepareProjectPackage,
  ProjectPackageError,
  projectPackageStream,
  restoreProjectPackage
} from "../src/lib/project-package/service";
import { createAssetStorage } from "../src/lib/storage";
import { ensurePersonalWorkspace } from "../src/lib/workspaces";

function wav(): Uint8Array {
  const samples = 800;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(Math.sin(index / 5) * 8000), 44 + index * 2);
  return new Uint8Array(buffer);
}

async function collect(stream: Readable) {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function main() {
  const storage = createAssetStorage();
  const userId = randomUUID();
  const strangerId = randomUUID();
  const projectIds: string[] = [];
  const keys: string[] = [];
  try {
    for (const id of [userId, strangerId]) {
      await db.user.create({ data: { id, email: `package-${id}@example.test`, displayName: "Package Smoke" } });
    }
    const audioBytes = wav();
    const created = await createProjectWithAudio({
      userId, displayName: "Package Smoke",
      project: { title: "Package Smoke / Ünïcode", description: "Round trip", aspectRatio: "16:9", frameRate: 24 },
      audio: { originalFileName: "master.wav", bytes: audioBytes }
    });
    projectIds.push(created.projectId);
    const workspace = await ensurePersonalWorkspace(userId, "Package Smoke");

    // One present image and one video whose object is missing from storage.
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000105fe02fea70000000049454e44ae426082", "hex");
    const media: Array<{ kind: AssetKind; contentType: string; body: Buffer | null }> = [
      { kind: AssetKind.GENERATED_IMAGE, contentType: "image/png", body: png },
      { kind: AssetKind.GENERATED_VIDEO, contentType: "video/mp4", body: null }
    ];
    const versionIds: string[] = [];
    for (const item of media) {
      const versionId = randomUUID();
      versionIds.push(versionId);
      const key = `workspaces/${workspace.id}/projects/${created.projectId}/smoke/${versionId}`;
      if (item.body) { await storage.put({ key, body: item.body, contentType: item.contentType }); keys.push(key); }
      const node = await db.domainVersionNode.create({ data: { kind: DomainVersionKind.ASSET } });
      await db.asset.create({ data: { workspaceId: workspace.id, projectId: created.projectId, kind: item.kind, name: item.kind,
        versions: { create: { id: versionId, nodeId: node.id, versionNumber: 1, status: AssetStatus.READY, storageKey: key,
          contentType: item.contentType, byteSize: item.body ? BigInt(item.body.length) : null,
          checksumSha256: item.body ? createHash("sha256").update(item.body).digest("hex") : null,
          metadata: { role: "initial-frame", sourceShotSpecificationVersionId: randomUUID() } } } } });
    }

    await assert.rejects(prepareProjectPackage({ userId: strangerId, projectId: created.projectId }), ProjectPackageError);
    const prepared = await prepareProjectPackage({ userId, projectId: created.projectId });
    assert.equal(prepared.fileName, "Package-Smoke-Unicode.mvwpkg.tar");
    assert.deepEqual(prepared.manifest.missingMedia.map(item => item.assetVersionId), [versionIds[1]]);
    assert.equal(prepared.media.length, 2);
    const archive = await collect(projectPackageStream(prepared));
    assert.equal(archive.length % 512, 0);

    const report = await restoreProjectPackage({ userId: strangerId, displayName: "Stranger", body: Readable.from([archive]) });
    projectIds.push(report.projectId);
    assert.equal(report.restoredMedia, 2);
    assert.equal(report.audioMasterRestored, true);
    assert.deepEqual(report.missingMedia.map(item => item.assetVersionId), [versionIds[1]]);
    const restored = await db.projectVersion.findFirstOrThrow({ where: { projectId: report.projectId },
      include: { project: { include: { workspace: { include: { memberships: true } } } }, audioMasterAssetVersion: true } });
    assert.equal(restored.project.title, "Package Smoke / Ünïcode");
    assert.equal(restored.frameRate, 24);
    assert.ok(restored.project.workspace.memberships.some(member => member.userId === strangerId));
    assert.equal(restored.audioMasterAssetVersion?.checksumSha256, createHash("sha256").update(audioBytes).digest("hex"));
    const image = await db.assetVersion.findFirstOrThrow({ where: { asset: { projectId: report.projectId, kind: AssetKind.GENERATED_IMAGE } } });
    assert.equal(image.checksumSha256, createHash("sha256").update(png).digest("hex"));
    assert.equal((image.metadata as { role?: string }).role, undefined, "Source provenance must not look like live links.");
    assert.ok(await storage.exists(image.storageKey));
    keys.push(image.storageKey, restored.audioMasterAssetVersion!.storageKey);

    // A corrupted media byte is reported as missing, never restored.
    const tampered = Buffer.from(archive);
    const pngOffset = tampered.indexOf(png);
    assert.ok(pngOffset > 0);
    tampered[pngOffset + png.length - 1] = tampered[pngOffset + png.length - 1]! ^ 0xff;
    const tamperedReport = await restoreProjectPackage({ userId, displayName: "Package Smoke", body: Readable.from([tampered]) });
    projectIds.push(tamperedReport.projectId);
    assert.equal(tamperedReport.restoredMedia, 1);
    assert.ok(tamperedReport.missingMedia.some(item => item.assetVersionId === versionIds[0] && /checksum/.test(item.reason)));
    for (const version of await db.assetVersion.findMany({ where: { asset: { projectId: tamperedReport.projectId } } })) keys.push(version.storageKey);

    // Non-packages and truncated archives are rejected without creating projects.
    const before = await db.project.count();
    await assert.rejects(restoreProjectPackage({ userId, displayName: "x", body: Readable.from([Buffer.from("not a tar")]) }), ProjectPackageError);
    await assert.rejects(restoreProjectPackage({ userId, displayName: "x", body: Readable.from([archive.subarray(0, 1024)]) }), ProjectPackageError);
    assert.equal(await db.project.count(), before);
    console.log("Project package smoke test passed (export, restore, missing media, checksum tamper, access control).");
  } finally {
    for (const key of keys) await storage.delete(key).catch(() => undefined);
    for (const projectId of projectIds) {
      const versions = await db.projectVersion.findMany({ where: { projectId }, select: { id: true } });
      await db.wizardProgress.deleteMany({ where: { projectVersionId: { in: versions.map(v => v.id) } } });
      await db.projectVersion.deleteMany({ where: { projectId } });
      const assets = await db.asset.findMany({ where: { projectId }, include: { versions: true } });
      await db.assetVersion.deleteMany({ where: { assetId: { in: assets.map(a => a.id) } } });
      await db.asset.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
    }
    await db.workspace.deleteMany({ where: { memberships: { some: { userId: { in: [userId, strangerId] } } } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: [userId, strangerId] } } }).catch(() => undefined);
    await db.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
