import { describe, expect, it } from "vitest";
import { S3AssetStorage } from "./s3";

describe("S3-compatible master downloads", () => {
  it("signs attachment disposition separately from inline playback", async () => {
    const storage = new S3AssetStorage({ bucket: "test-media", region: "us-east-1", endpoint: "https://storage.example.test",
      forcePathStyle: true, accessKeyId: "test-access", secretAccessKey: "test-secret" });
    const playback = new URL(await storage.getSignedReadUrl("master.mp4", 60));
    expect(playback.searchParams.has("response-content-disposition")).toBe(false);
    const download = new URL(await storage.getSignedReadUrl("master.mp4", 60, "master-v1.mp4"));
    expect(download.searchParams.get("response-content-disposition")).toContain('attachment; filename="master-v1.mp4"');
    expect(download.searchParams.get("X-Amz-Signature")).not.toBe(playback.searchParams.get("X-Amz-Signature"));
  });
});
