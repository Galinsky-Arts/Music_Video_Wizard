"use client";

import { useCallback, useEffect, useState } from "react";
import { formatTimecode } from "@/lib/collaboration/timecode";

type Framing = { mode: "fit" | "fill"; zoom: number; focusX: number; focusY: number } | null;
type Delivery = {
  presets: { key: string; label: string; width: number; height: number }[];
  variants: { presetKey: string; label: string; width: number | null; height: number | null; byteSize: string | null; downloadUrl: string }[];
  jobs: { id: string; status: string; progressPercent: number; progressMessage: string | null; errorMessage: string | null; presetKey: string | null }[];
  shots: { position: number; timelineStartMs: number; timelineEndMs: number; framing: Framing }[];
  sourceError: string | null;
  performanceSync: { enabled: boolean; provider: string | null; missing: string[] };
};
type Marker = { timeMs: number; kind: string; label: string };

export function DeliveryStudio({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState("vertical-1080");
  const [framingMode, setFramingMode] = useState<"fill" | "fit">("fill");
  const [focus, setFocus] = useState<Record<string, number>>({});
  const [grid, setGrid] = useState("bar");
  const [minShotMs, setMinShotMs] = useState(1200);
  const [markers, setMarkers] = useState<{ bpm: number; markers: Marker[] } | null>(null);
  const base = `/api/projects/${projectId}`;

  const load = useCallback(async () => {
    const response = await fetch(`${base}/delivery`, { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setData(body); else setError(body.error ?? "Unable to load delivery options.");
  }, [base]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data?.jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING")) return;
    const timer = setTimeout(() => void load(), 4000);
    return () => clearTimeout(timer);
  }, [data, load]);

  async function render() {
    setError(null);
    const focusOverrides = Object.fromEntries(Object.entries(focus).map(([position, focusX]) => [position, { focusX }]));
    const response = await fetch(`${base}/delivery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ presetKey: preset, framingMode, focusOverrides }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setError(body.error ?? "Render failed to start."); else void load();
  }

  async function loadMarkers() {
    setError(null);
    const response = await fetch(`${base}/performance/markers?grid=${grid}&minShotMs=${minShotMs}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setError(body.error ?? "Unable to build markers."); else setMarkers(body);
  }

  if (!data) return <p role="status">{error ?? "Loading…"}</p>;
  const running = data.jobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const lastFailed = data.jobs[0]?.status === "FAILED" ? data.jobs[0] : null;

  return (
    <div className="projectSection">
      {error ? <p className="formError" role="alert">{error}</p> : null}

      <section className="dashboardCard" aria-labelledby="formats-heading">
        <h2 id="formats-heading">Alternate formats</h2>
        <p>Render the locked edit again at another size. <strong>Reframe</strong> crops each shot using its crop/reframe focus from Refinement (adjust per shot below); <strong>Letterbox</strong> keeps the whole frame.</p>
        {data.sourceError ? <p className="formError">{data.sourceError}</p> : (
          <>
            <label>Format{" "}
              <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                {data.presets.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
              </select>
            </label>{" "}
            <label>Framing{" "}
              <select value={framingMode} onChange={(event) => setFramingMode(event.target.value as "fill" | "fit")}>
                <option value="fill">Reframe (crop to fill)</option>
                <option value="fit">Letterbox (fit whole frame)</option>
              </select>
            </label>{" "}
            <button className="primaryButton" type="button" disabled={Boolean(running)} onClick={() => void render()}>Render format</button>
            {framingMode === "fill" ? (
              <details>
                <summary>Per-shot horizontal focus ({data.shots.length} shots)</summary>
                <ul>
                  {data.shots.map((shot) => {
                    const value = focus[String(shot.position)] ?? shot.framing?.focusX ?? 0.5;
                    return (
                      <li key={shot.position}>
                        <label>Shot {shot.position + 1} ({formatTimecode(shot.timelineStartMs)}–{formatTimecode(shot.timelineEndMs)}) focus{" "}
                          <input type="range" min={0} max={1} step={0.05} value={value} onChange={(event) => setFocus({ ...focus, [String(shot.position)]: Number(event.target.value) })} />
                          {" "}{Math.round(value * 100)}%
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ) : null}
          </>
        )}
        {running ? <p role="status">Rendering {running.presetKey}: {running.progressPercent}% {running.progressMessage ?? ""}</p> : null}
        {lastFailed ? <p className="formError">Last render failed: {lastFailed.errorMessage}</p> : null}
        <ul>
          {data.variants.map((variant) => (
            <li key={variant.presetKey}>
              <a href={variant.downloadUrl}>{variant.label}</a> · {variant.width}×{variant.height}
              {variant.byteSize ? ` · ${(Number(variant.byteSize) / 1048576).toFixed(1)} MB` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="dashboardCard" aria-labelledby="interchange-heading">
        <h2 id="interchange-heading">Open in another editor</h2>
        <p>Export the locked timeline for Final Cut Pro / DaVinci Resolve (FCPXML 1.9) or Premiere / Avid / Resolve (CMX3600 EDL). Download the media listed in the manifest into a <code>media</code> folder next to the file, then relink by name. Transitions come through as cuts with a note.</p>
        <p>
          <a className="secondaryButton linkButton" href={`${base}/interchange?format=fcpxml`}>FCPXML</a>{" "}
          <a className="secondaryButton linkButton" href={`${base}/interchange?format=edl`}>EDL (CMX3600)</a>{" "}
          <a className="secondaryButton linkButton" href={`${base}/interchange?format=manifest`}>Media manifest (JSON, links valid 24 h)</a>
        </p>
      </section>

      <section className="dashboardCard" aria-labelledby="markers-heading">
        <h2 id="markers-heading">Beat-synced cuts &amp; choreography markers</h2>
        <p>Built locally from Music Analysis: cut points on the beat grid (structure changes and drops always cut) and dance 8-counts. Free; no provider needed.</p>
        <label>Cut every{" "}
          <select value={grid} onChange={(event) => setGrid(event.target.value)}>
            <option value="beat">beat</option><option value="2-beats">2 beats</option><option value="bar">bar</option><option value="2-bars">2 bars</option><option value="4-bars">4 bars</option>
          </select>
        </label>{" "}
        <label>Minimum shot (ms) <input type="number" min={0} max={10000} step={100} value={minShotMs} onChange={(event) => setMinShotMs(Number(event.target.value))} /></label>{" "}
        <button className="secondaryButton" type="button" onClick={() => void loadMarkers()}>Build markers</button>{" "}
        <a className="secondaryButton linkButton" href={`${base}/performance/markers?grid=${grid}&minShotMs=${minShotMs}&format=csv`}>Download CSV</a>
        {markers ? (
          <>
            <p>{Math.round(markers.bpm)} BPM · {markers.markers.filter((m) => m.kind === "cut").length} cuts</p>
            <ol className="markerList">
              {markers.markers.filter((m) => m.kind !== "count").slice(0, 200).map((marker, index) => (
                <li key={index}><code>{formatTimecode(marker.timeMs)}</code> {marker.label}</li>
              ))}
            </ol>
          </>
        ) : null}
      </section>

      <section className="dashboardCard" aria-labelledby="sync-heading">
        <h2 id="sync-heading">Lip-sync &amp; performance sync</h2>
        {data.performanceSync.enabled ? (
          <p>Provider <strong>{data.performanceSync.provider}</strong> is configured. Results come back as clips you add with Media Import. This integration has not been validated with a demonstrated result yet.</p>
        ) : (
          <p>Off. No lip-sync or choreography provider is configured. To turn it on, set <code>{data.performanceSync.missing.join(", ")}</code> on the server. Generic video generation cannot promise exact lip or dance timing, so this stays off until a supporting provider is connected.</p>
        )}
      </section>
    </div>
  );
}
