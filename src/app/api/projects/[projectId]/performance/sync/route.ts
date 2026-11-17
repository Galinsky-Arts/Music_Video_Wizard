import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projectEditorWhere } from "@/lib/collaboration/access";
import { PerformanceSyncOffError, performanceSyncStatus, submitPerformanceSync } from "@/lib/performance/providers";

export const runtime = "nodejs";

/** Off unless PERFORMANCE_SYNC_* is configured; see src/lib/performance/providers.ts. */
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { projectId } = await context.params;
  const project = await db.project.findFirst({ where: { id: projectId, archivedAt: null, ...projectEditorWhere(session.user.id) }, select: { id: true } });
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  const status = performanceSyncStatus();
  if (!status.enabled) return Response.json({ error: new PerformanceSyncOffError(status).message, status }, { status: 400 });
  const body = await request.json().catch(() => null) as { kind?: string; videoUrl?: string; audioUrl?: string; startMs?: number; endMs?: number } | null;
  try {
    const result = await submitPerformanceSync({
      kind: body?.kind === "choreography-reference" ? "choreography-reference" : "lip-sync",
      videoUrl: String(body?.videoUrl ?? ""), audioUrl: String(body?.audioUrl ?? ""),
      startMs: Number(body?.startMs), endMs: Number(body?.endMs),
    });
    return Response.json({ ...result, next: "When the provider finishes, import the result with Media Import." });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Submission failed." }, { status: 502 });
  }
}
