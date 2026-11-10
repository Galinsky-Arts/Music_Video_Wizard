import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMediaProcess } from "@/lib/media/process";
import { verifyGeneratedClip } from "./verification";
let directory: string, bytes: Uint8Array;
const tools = { ffmpeg: process.env.VIDEO_RENDER_FFMPEG ?? "ffmpeg", ffprobe: process.env.VIDEO_RENDER_FFPROBE ?? "ffprobe", signal: new AbortController().signal, maxBytes: 52428800 };
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(),"generated-verify-"));const path = join(directory,"real-clip.mp4");
  await runMediaProcess({ executable: tools.ffmpeg, args: ["-v","error","-f","lavfi","-i","color=c=blue:s=160x96:r=16:d=1","-threads","1","-y",path], signal: tools.signal, description: "Generated clip acceptance fixture" }); bytes = await readFile(path);
});
afterAll(async () => { if (directory) await rm(directory,{recursive:true,force:true}); });
describe("generated clip evidence", () => {
  it("records decoded frame rate, geometry and duration rather than trusting provider claims", async () => {
    expect(await verifyGeneratedClip({...tools,bytes,minimumDurationMs:1000})).toMatchObject({contentType:"video/mp4",width:160,height:96,frameRate:16,durationMs:1000});
  });
  it("rejects truncated clips, overlong editorial requirements and oversized media", async () => {
    await expect(verifyGeneratedClip({...tools,bytes:bytes.subarray(0,100),minimumDurationMs:1000})).rejects.toThrow();
    await expect(verifyGeneratedClip({...tools,bytes,minimumDurationMs:1500})).rejects.toThrow(/does not cover/);
    await expect(verifyGeneratedClip({...tools,bytes,minimumDurationMs:1000,maxBytes:10})).rejects.toThrow(/size limit/);
  });
});
