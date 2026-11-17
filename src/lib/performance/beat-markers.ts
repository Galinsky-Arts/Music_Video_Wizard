import type { MusicAnalysisResult } from "@/lib/music-analysis/result";

/**
 * Free, local beat-synced cut and choreography markers from the existing music
 * analysis (beats, 4/4 bar candidates, sections, drops). No provider involved.
 */
export const CUT_GRIDS = { beat: 1, "2-beats": 2, bar: 4, "2-bars": 8, "4-bars": 16 } as const;
export type CutGrid = keyof typeof CUT_GRIDS;

export interface Marker {
  timeMs: number;
  kind: "cut" | "count" | "section" | "drop";
  label: string;
}

export interface MarkerOptions {
  grid: CutGrid;
  /** Do not cut more often than this (keeps fast grids usable at high BPM). */
  minShotMs: number;
  /** Always cut on section boundaries and drops. */
  accentStructure: boolean;
  /** Emit dance 8-counts (1..8, two 4/4 bars per count). */
  choreographyCounts: boolean;
}

export const DEFAULT_MARKER_OPTIONS: MarkerOptions = { grid: "bar", minShotMs: 1200, accentStructure: true, choreographyCounts: true };

export function buildBeatMarkers(analysis: Pick<MusicAnalysisResult, "beatsMs" | "barCandidates" | "sections" | "drops" | "durationMs">, options: MarkerOptions = DEFAULT_MARKER_OPTIONS): Marker[] {
  const beats = [...analysis.beatsMs].sort((a, b) => a - b);
  const bars = new Set(analysis.barCandidates.barsMs);
  const markers: Marker[] = [];
  const step = CUT_GRIDS[options.grid];
  // Align the cut grid to the first downbeat so bar-based grids land on "1".
  const firstDownbeat = Math.max(0, beats.findIndex((beat) => bars.has(beat)));
  const structural = options.accentStructure
    ? [
        ...analysis.sections.filter((section) => section.startMs > 0).map((section) => ({ timeMs: section.startMs, kind: "section" as const, label: "Section: " + section.label })),
        ...analysis.drops.map((drop) => ({ timeMs: drop.timeMs, kind: "drop" as const, label: "Drop" })),
      ]
    : [];
  const candidates: { timeMs: number; forced: boolean }[] = structural.map((entry) => ({ timeMs: entry.timeMs, forced: true }));
  for (let index = firstDownbeat; index < beats.length; index += step) {
    if (beats[index]! > 0) candidates.push({ timeMs: beats[index]!, forced: false });
  }
  candidates.sort((a, b) => a.timeMs - b.timeMs || Number(b.forced) - Number(a.forced));
  let lastCut = 0;
  for (const candidate of candidates) {
    if (candidate.timeMs >= analysis.durationMs) break;
    const gap = candidate.timeMs - lastCut;
    if (gap <= 0 || (!candidate.forced && gap < options.minShotMs) || (candidate.forced && gap < 200)) continue;
    markers.push({ timeMs: candidate.timeMs, kind: "cut", label: candidate.forced ? "Cut (structure)" : "Cut (" + options.grid + ")" });
    lastCut = candidate.timeMs;
  }
  markers.push(...structural);
  if (options.choreographyCounts) {
    for (let index = firstDownbeat, count = 0; index < beats.length; index += 1, count += 1) {
      markers.push({ timeMs: beats[index]!, kind: "count", label: String((count % 8) + 1) });
    }
  }
  return markers.sort((a, b) => a.timeMs - b.timeMs || a.kind.localeCompare(b.kind));
}

export function markersToCsv(markers: Marker[]) {
  const rows = ["time_ms,timecode,kind,label"];
  for (const marker of markers) {
    const total = marker.timeMs / 1000;
    const tc = Math.floor(total / 60) + ":" + (total % 60).toFixed(3).padStart(6, "0");
    rows.push([marker.timeMs, tc, marker.kind, '"' + marker.label.replace(/"/g, '""') + '"'].join(","));
  }
  return rows.join("\n") + "\n";
}
