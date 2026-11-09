import { z, ZodError } from "zod";
import { auth } from "@/lib/auth";
import { getEnvironment } from "@/lib/env";
import { ensureWizardProgress, WizardError } from "@/lib/wizard/service";
import { importShotMedia } from "@/lib/media-imports/service";
import { MediaImportError, readBoundedFormData } from "@/lib/media-imports/probe";

export const runtime = "nodejs";
const inputSchema = z.object({ kind: z.enum(["image", "video"]), shotSpecificationVersionId: z.string().uuid(), expectedWizardRevision: z.coerce.number().int().min(0) });
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { projectId } = await context.params;
    await ensureWizardProgress({ userId: session.user.id, projectId });
    const env = getEnvironment();
    const form = await readBoundedFormData(request, env.MAX_MEDIA_UPLOAD_BYTES + 65536);
    const input = inputSchema.parse(Object.fromEntries(["kind", "shotSpecificationVersionId", "expectedWizardRevision"].map(key => [key, form.get(key)])));
    const file = form.get("media");
    if (!(file instanceof File)) throw new MediaImportError("Choose a media file.");
    return Response.json(await importShotMedia({ ...input, userId: session.user.id, projectId,
      originalFileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }), { status: 201 });
  } catch (error) {
    if (error instanceof MediaImportError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof WizardError) return Response.json({ error: "Project unavailable." }, { status: 404 });
    if (error instanceof ZodError) return Response.json({ error: "Invalid media import settings." }, { status: 400 });
    console.error("Media import failed", error);
    return Response.json({ error: "Media import could not be completed. Refresh before trying again." }, { status: 500 });
  }
}
