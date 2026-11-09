import { describe, expect, it } from "vitest";
import { runMediaProcess } from "./process";

describe("native media process lifecycle", () => {
  it("terminates a running process when its job is aborted", async () => {
    await expect(runMediaProcess({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      signal: AbortSignal.timeout(150), description: "Timed-out render" })).rejects.toThrow(/timeout/i);
  });
  it("rejects an unavailable executable", async () => {
    await expect(runMediaProcess({ executable: "/nonexistent/mvw-tool", args: [], signal: new AbortController().signal,
      description: "Media probe" })).rejects.toThrow(/could not start/);
  });
  it("terminates a probe that exceeds the bounded stdout limit", async () => {
    await expect(runMediaProcess({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      signal: AbortSignal.timeout(5000), description: "Oversized probe", captureStdout: true })).rejects.toThrow(/too much output/);
  });
});
