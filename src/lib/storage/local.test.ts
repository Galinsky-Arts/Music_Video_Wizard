import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalAssetStorage,
  readLocalAsset,
  verifyLocalAssetSignature
} from "./local";

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("LocalAssetStorage", () => {
  it("binds the download filename to the signed URL", async () => {
    const storage = new LocalAssetStorage("/unused", "http://localhost:3000", "download-secret");
    const signed = new URL(await storage.getSignedReadUrl("master.mp4", 60, "master-v1.mp4"));
    const key = signed.searchParams.get("key")!;
    const expires = Number(signed.searchParams.get("expires"));
    const signature = signed.searchParams.get("signature")!;
    expect(verifyLocalAssetSignature(key, expires, signature, "download-secret", "master-v1.mp4")).toBe(true);
    expect(verifyLocalAssetSignature(key, expires, signature, "download-secret", "tampered.mp4")).toBe(false);
    expect(verifyLocalAssetSignature(key, expires, signature, "download-secret")).toBe(false);
  });
  it("writes immutable objects and produces verifiable signed URLs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mvw-storage-"));
    createdRoots.push(root);
    const secret = "0123456789abcdef0123456789abcdef";
    const storage = new LocalAssetStorage(
      root,
      "http://localhost:3000",
      secret
    );

    const body = new Uint8Array([1, 2, 3, 4]);
    await storage.put({
      key: "workspace/project/master.wav",
      body,
      contentType: "audio/wav"
    });

    expect(await storage.exists("workspace/project/master.wav")).toBe(true);
    expect(
      Array.from(await readLocalAsset(root, "workspace/project/master.wav"))
    ).toEqual([1, 2, 3, 4]);

    await expect(
      storage.put({
        key: "workspace/project/master.wav",
        body,
        contentType: "audio/wav"
      })
    ).rejects.toThrow();

    const signed = new URL(
      await storage.getSignedReadUrl("workspace/project/master.wav", 60)
    );
    const key = signed.searchParams.get("key");
    const expires = Number(signed.searchParams.get("expires"));
    const signature = signed.searchParams.get("signature");

    expect(key).toBe("workspace/project/master.wav");
    expect(signature).toBeTruthy();
    expect(
      verifyLocalAssetSignature(key!, expires, signature!, secret)
    ).toBe(true);
  });


  it("copies immutable files without buffering the asset in the storage API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mvw-storage-"));
    createdRoots.push(root);
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "mvw-storage-source-"));
    createdRoots.push(sourceRoot);
    const sourcePath = path.join(sourceRoot, "master.mp4");
    await writeFile(sourcePath, new Uint8Array([9, 8, 7, 6, 5]));

    const storage = new LocalAssetStorage(
      root,
      "http://localhost:3000",
      "0123456789abcdef0123456789abcdef"
    );
    const stored = await storage.putFile({
      key: "workspace/project/renders/master.mp4",
      filePath: sourcePath,
      contentType: "video/mp4"
    });

    expect(stored.size).toBe(5);
    expect(
      Array.from(
        await readLocalAsset(
          root,
          "workspace/project/renders/master.mp4"
        )
      )
    ).toEqual([9, 8, 7, 6, 5]);

    await expect(
      storage.putFile({
        key: "workspace/project/renders/master.mp4",
        filePath: sourcePath,
        contentType: "video/mp4"
      })
    ).rejects.toThrow();
  });

  it("prevents path traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mvw-storage-"));
    createdRoots.push(root);
    const storage = new LocalAssetStorage(
      root,
      "http://localhost:3000",
      "0123456789abcdef0123456789abcdef"
    );

    await expect(
      storage.put({
        key: "../../escape.wav",
        body: new Uint8Array([1]),
        contentType: "audio/wav"
      })
    ).rejects.toThrow(/escapes/);
  });
});
