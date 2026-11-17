import { auth } from "@/lib/auth";
import { getMusicAnalysisState } from "@/lib/music-analysis/service";
import { buildBeatMarkers, CUT_GRIDS, markersToCsv, type CutGrid } from "@/lib/performance/beat-markers";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const grid = (params.get("grid") ?? "bar") as CutGrid;
  if (!(grid in CUT_GRIDS)) return Response.json({ error: "Unknown grid." }, { status: 400 });
  const minShotMs = Math.min(10_000, Math.max(0, Number(params.get("minShotMs") ?? 1200) || 0));
  try {
    const { projectId } = await context.params;
    const state = await getMusicAnalysisState({ userId: session.user.id, projectId });
    if (!state.latest) return Response.json({ error: "Run Music Analysis first; markers are built from its beats and sections." }, { status: 409 });
    const markers = buildBeatMarkers(state.latest.result, {
      grid, minShotMs, accentStructure: params.get("accent") !== "0", choreographyCounts: params.get("counts") !== "0",
    });
    if (params.get("format") === "csv") {
      return new Response(markersToCsv(markers), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="beat-markers-' + grid + '.csv"', "Cache-Control": "private, no-store" } });
    }
    return Response.json({ bpm: state.latest.result.tempo.bpm, durationMs: state.latest.result.durationMs, markers }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return Response.json({ error: "Project not found." }, { status: 404 });
    console.error("Beat markers failed");
    return Response.json({ error: "Beat markers failed." }, { status: 500 });
  }
}
