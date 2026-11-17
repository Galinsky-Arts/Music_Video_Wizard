/**
 * Provider-neutral performance-sync adapter (plan PR 25: lip-sync / rap sync,
 * choreography or performance-reference video). OFF until a provider is
 * configured. No provider is integrated or validated yet: the plan requires a
 * supported provider AND a demonstrated result before this is advertised.
 *
 * Configure: PERFORMANCE_SYNC_PROVIDER (name shown in the UI),
 * PERFORMANCE_SYNC_API_BASE (https URL) and PERFORMANCE_SYNC_API_KEY.
 * Contract (to be mapped to the chosen provider's documented API):
 *   POST {base}/jobs {kind, video_url, audio_url, start_ms, end_ms} -> {id}
 *   GET  {base}/jobs/{id} -> {status, output_url?}
 * Finished output is brought into the project with Media Import.
 */
export type PerformanceSyncKind = "lip-sync" | "choreography-reference";

export interface PerformanceSyncStatus {
  enabled: boolean;
  provider: string | null;
  missing: string[];
  capabilities: PerformanceSyncKind[];
}

export function performanceSyncStatus(env: Record<string, string | undefined> = process.env): PerformanceSyncStatus {
  const provider = env.PERFORMANCE_SYNC_PROVIDER?.trim() || null;
  const base = safeBase(env.PERFORMANCE_SYNC_API_BASE);
  const missing = [
    !provider && "PERFORMANCE_SYNC_PROVIDER",
    !base && "PERFORMANCE_SYNC_API_BASE",
    !env.PERFORMANCE_SYNC_API_KEY?.trim() && "PERFORMANCE_SYNC_API_KEY",
  ].filter((value): value is string => Boolean(value));
  return { enabled: missing.length === 0, provider, missing, capabilities: ["lip-sync", "choreography-reference"] };
}

function safeBase(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname) ? value.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

export class PerformanceSyncOffError extends Error {
  constructor(status: PerformanceSyncStatus) {
    super("Performance sync is off. Set " + status.missing.join(", ") + " to enable it.");
  }
}

export async function submitPerformanceSync(
  request: { kind: PerformanceSyncKind; videoUrl: string; audioUrl: string; startMs: number; endMs: number },
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
) {
  const status = performanceSyncStatus(env);
  if (!status.enabled) throw new PerformanceSyncOffError(status);
  if (!(request.endMs > request.startMs)) throw new Error("End must be after start.");
  const response = await fetchImpl(safeBase(env.PERFORMANCE_SYNC_API_BASE)! + "/jobs", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.PERFORMANCE_SYNC_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: request.kind, video_url: request.videoUrl, audio_url: request.audioUrl, start_ms: request.startMs, end_ms: request.endMs }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as { id?: string };
  if (!response.ok || !body.id) throw new Error("Performance-sync provider rejected the request (" + response.status + ").");
  return { providerJobId: String(body.id) };
}
