import { describe, expect, it } from "vitest";
import { buildBeatMarkers, markersToCsv } from "./beat-markers";
import { PerformanceSyncOffError, performanceSyncStatus, submitPerformanceSync } from "./providers";

const beats = Array.from({ length: 64 }, (_, index) => 500 + index * 500); // 120 BPM from 0.5 s
const analysis = {
  durationMs: 33_000,
  beatsMs: beats,
  barCandidates: { meter: "4/4" as const, phase: 0, confidence: 0.9, barsMs: beats.filter((_, index) => index % 4 === 0) },
  sections: [{ index: 0, label: "intro", startMs: 0, endMs: 8000, meanEnergy: 0.2 }, { index: 1, label: "chorus", startMs: 8300, endMs: 33_000, meanEnergy: 0.8 }],
  drops: [{ timeMs: 16_500, score: 0.9, preEnergy: 0.3, postEnergy: 0.9 }],
};

describe("beat-synced markers", () => {
  it("cuts on bars, forces structure accents and respects the minimum shot length", () => {
    const markers = buildBeatMarkers(analysis, { grid: "bar", minShotMs: 1200, accentStructure: true, choreographyCounts: false });
    const cuts = markers.filter((m) => m.kind === "cut").map((m) => m.timeMs);
    expect(cuts.slice(0, 4)).toEqual([2500, 4500, 6500, 8300]);
    expect(cuts).toContain(16_500);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]! - cuts[i - 1]!).toBeGreaterThanOrEqual(200);
    expect(markers.some((m) => m.kind === "section" && m.label.includes("chorus"))).toBe(true);
  });

  it("thins fast grids and emits 8-counts", () => {
    const fast = buildBeatMarkers(analysis, { grid: "beat", minShotMs: 1200, accentStructure: false, choreographyCounts: true });
    const cuts = fast.filter((m) => m.kind === "cut").map((m) => m.timeMs);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]! - cuts[i - 1]!).toBeGreaterThanOrEqual(1200);
    const counts = fast.filter((m) => m.kind === "count").map((m) => m.label);
    expect(counts.slice(0, 9)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "1"]);
    expect(markersToCsv(fast).split("\n")[0]).toBe("time_ms,timecode,kind,label");
  });
});

describe("performance-sync provider adapter", () => {
  it("is off until provider, base URL and key are all set", async () => {
    expect(performanceSyncStatus({})).toMatchObject({ enabled: false, missing: ["PERFORMANCE_SYNC_PROVIDER", "PERFORMANCE_SYNC_API_BASE", "PERFORMANCE_SYNC_API_KEY"] });
    expect(performanceSyncStatus({ PERFORMANCE_SYNC_PROVIDER: "x", PERFORMANCE_SYNC_API_BASE: "http://evil.example", PERFORMANCE_SYNC_API_KEY: "k" }).enabled).toBe(false);
    await expect(submitPerformanceSync({ kind: "lip-sync", videoUrl: "v", audioUrl: "a", startMs: 0, endMs: 1 }, {})).rejects.toBeInstanceOf(PerformanceSyncOffError);
  });

  it("submits through the neutral contract when configured", async () => {
    const env = { PERFORMANCE_SYNC_PROVIDER: "test", PERFORMANCE_SYNC_API_BASE: "https://provider.example/v1/", PERFORMANCE_SYNC_API_KEY: "secret" };
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: "job-1" }), { status: 200 }); }) as unknown as typeof fetch;
    await expect(submitPerformanceSync({ kind: "lip-sync", videoUrl: "v", audioUrl: "a", startMs: 1000, endMs: 5000 }, env, fake)).resolves.toEqual({ providerJobId: "job-1" });
    expect(calls[0]!.url).toBe("https://provider.example/v1/jobs");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ kind: "lip-sync", start_ms: 1000, end_ms: 5000 });
  });
});
