import { auth } from "@/lib/auth";
import { DeliveryError, listDeliveryVariants, queueDeliveryVariant } from "@/lib/delivery/service";
import { getCurrentRenderManifest } from "@/lib/finish-export/service";
import { performanceSyncStatus } from "@/lib/performance/providers";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

function failure(error: unknown, label: string) {
  if (error instanceof DeliveryError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof Error && /Lock the Refinement|not found|Project/i.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
  console.error(label + " failed");
  return Response.json({ error: label + " failed." }, { status: 500 });
}

export async function GET(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { projectId } = await context.params;
    const input = { userId: session.user.id, projectId };
    const listing = await listDeliveryVariants(input);
    let shots: { position: number; timelineStartMs: number; timelineEndMs: number; framing: unknown }[] = [];
    let sourceError: string | null = null;
    try {
      const { manifest } = await getCurrentRenderManifest(input);
      shots = manifest.items.map((item) => ({ position: item.position, timelineStartMs: item.timelineStartMs, timelineEndMs: item.timelineEndMs, framing: item.framing ?? null }));
    } catch (error) {
      sourceError = error instanceof Error ? error.message : "Timeline is not ready.";
    }
    return Response.json({ ...listing, shots, sourceError, performanceSync: performanceSyncStatus() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return failure(error, "Delivery listing");
  }
}

export async function POST(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return Response.json({ error: "JSON body required." }, { status: 415 });
  const body = await request.json().catch(() => null) as { presetKey?: unknown; framingMode?: unknown; focusOverrides?: unknown } | null;
  try {
    const { projectId } = await context.params;
    const overrides = body?.focusOverrides && typeof body.focusOverrides === "object" && !Array.isArray(body.focusOverrides) ? body.focusOverrides as Record<string, { focusX?: number; focusY?: number; zoom?: number }> : undefined;
    return Response.json(await queueDeliveryVariant({
      userId: session.user.id, projectId,
      presetKey: String(body?.presetKey ?? ""),
      framingMode: body?.framingMode === "fit" ? "fit" : "fill",
      focusOverrides: overrides,
    }));
  } catch (error) {
    return failure(error, "Delivery render");
  }
}
