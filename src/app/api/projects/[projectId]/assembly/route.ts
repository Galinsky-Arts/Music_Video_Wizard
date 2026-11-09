import { z, ZodError } from "zod";
import { auth } from "@/lib/auth";
import { getEnvironment } from "@/lib/env";
import { ensureWizardProgress, WizardError } from "@/lib/wizard/service";
import { importVisualAssembly } from "@/lib/assembly/service";
import { MediaImportError, readBoundedFormData } from "@/lib/media-imports/probe";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { projectId } = await context.params;
    await ensureWizardProgress({ userId: session.user.id, projectId });
    const form = await readBoundedFormData(request, getEnvironment().MAX_MEDIA_UPLOAD_BYTES + 65536);
    const revision = z.coerce.number().int().min(0).parse(form.get("expectedWizardRevision"));
    const height = z.coerce.number().refine(value => value === 720 || value === 1080).parse(form.get("height")) as 720 | 1080;
    const file = form.get("media");
    if (!(file instanceof File)) throw new MediaImportError("Choose a complete visual edit.");
    return Response.json(await importVisualAssembly({ userId: session.user.id, projectId, expectedWizardRevision: revision, height,
      bytes: new Uint8Array(await file.arrayBuffer()), originalFileName: file.name }), { status: 201 });
  } catch (error) {
    if (error instanceof MediaImportError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof WizardError) return Response.json({ error: "Project unavailable." }, { status: 404 });
    if (error instanceof ZodError) return Response.json({ error: "Invalid assembly settings." }, { status: 400 });
    console.error("Assembly import failed", error);
    return Response.json({ error: "The assembly could not be imported. Refresh the project before retrying." }, { status: 500 });
  }
}
