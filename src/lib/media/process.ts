import { spawn } from "node:child_process";

/** Run native media tools without a shell, with bounded diagnostics and cancellation. */
export async function runMediaProcess(input: {
  executable: string;
  args: string[];
  signal: AbortSignal;
  description: string;
  captureStdout?: boolean;
}): Promise<string> {
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      stdio: ["ignore", input.captureStdout ? "pipe" : "ignore", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref();
    };
    const onAbort = () => stop(
      input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error(input.description + " aborted.")
    );
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > 1024 * 1024) {
        stop(new Error(input.description + " produced too much output."));
      } else stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    child.once("error", error => {
      failure ??= new Error(input.description + " could not start: " + error.message);
    });
    child.once("close", code => {
      if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(
        input.description + " failed with exit code " + String(code) +
        (stderr.trim() ? ": " + stderr.trim() : "")
      ));
      else resolve(stdout);
    });
  });
}
