import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./disposition";

describe("media download headers", () => {
  it("encodes Unicode names and prevents header/quoted-string injection", () => {
    const disposition = attachmentDisposition('vidéo "master"\r\n.mp4');
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="vid_o _master___.mp4"');
    expect(disposition).toContain("filename*=UTF-8''vid%C3%A9o%20%22master%22%0D%0A.mp4");
    expect(() => new Headers({ "content-disposition": disposition })).not.toThrow();
  });
});
