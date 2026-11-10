import { z, ZodError } from "zod";
import { auth } from "@/lib/auth";
import { ensureWizardProgress, WizardError } from "@/lib/wizard/service";
import { narrativePlanSchema } from "@/lib/narrative/plan";
import { getNarrativePlan, saveNarrativePlan, NarrativeError } from "@/lib/narrative/service";
export const runtime = "nodejs";
function handled(error: unknown) {
  if (error instanceof NarrativeError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof WizardError) return Response.json({ error: "Project unavailable." }, { status: 404 });
  if (error instanceof ZodError || error instanceof SyntaxError) return Response.json({ error: "Invalid narrative plan. Check its timing and required fields." }, { status: 400 });
  console.error("Narrative request failed", error); return Response.json({ error: "The narrative request failed." }, { status: 500 });
}
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers }); if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { return Response.json(await getNarrativePlan({ userId: session.user.id, projectId: (await context.params).projectId })); } catch (e) { return handled(e); }
}
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers }); if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { projectId } = await context.params; await ensureWizardProgress({ userId: session.user.id, projectId });
    const reader = request.body?.getReader(); if (!reader) throw new NarrativeError("A narrative plan is required.");
    let size = 0; const parts: Uint8Array[] = [];
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 256 * 1024) { await reader.cancel(); throw new NarrativeError("The narrative plan exceeds 256 KB.", 413); } parts.push(part.value); }
    } finally { reader.releaseLock(); }
    const body = z.object({ expectedVersionId: z.string().uuid().nullable(), plan: narrativePlanSchema }).strict().parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    return Response.json(await saveNarrativePlan({ userId: session.user.id, projectId, ...body }), { status: 201 });
  } catch (e) { return handled(e); }
}
