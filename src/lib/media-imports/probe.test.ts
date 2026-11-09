import { describe, expect, it } from "vitest";
import { detectImportedMedia, readBoundedFormData } from "./probe";

describe("media import boundary", () => {
  it("ignores file names and rejects executable/playlist bytes", () => {
    expect(() => detectImportedMedia(Buffer.from('#EXTM3U\nhttps://example.com/file.mp4'), "video")).toThrow(/Upload/);
    expect(() => detectImportedMedia(Buffer.from('<svg onload="alert(1)"></svg>'), "image")).toThrow(/PNG/);
    expect(detectImportedMedia(Buffer.from([137,80,78,71,13,10,26,10]), "image").contentType).toBe("image/png");
  });
  it("bounds chunked requests even without Content-Length", async () => {
    const request = new Request("https://example.test/import", { method: "POST", body: new Uint8Array(30) });
    await expect(readBoundedFormData(request, 10)).rejects.toMatchObject({ status: 413 });
  });
  it("parses an actual bounded multipart file", async () => {
    const body = new FormData(); body.set("media", new File(["frame"], "art.png"));
    const result = await readBoundedFormData(new Request("https://example.test/import", { method: "POST", body }), 1024);
    expect((result.get("media") as File).name).toBe("art.png");
  });
});
