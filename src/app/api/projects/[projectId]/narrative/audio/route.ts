import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createAssetStorage } from "@/lib/storage";
import { ensureWizardProgress, WizardError } from "@/lib/wizard/service";
export const runtime = "nodejs";

// Same-origin, authenticated audio retrieval: private storage needs no browser CORS changes.
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let scratch: string | undefined;
  try {
    const project = await ensureWizardProgress({ userId: session.user.id, projectId: (await context.params).projectId });
    const requested = new URL(request.url).searchParams.get("version");
    if (!requested || requested !== project.audioMasterAssetVersionId) return Response.json({ error: "Soundtrack changed. Reload the project." }, { status: 409 });
    const audio = await db.assetVersion.findUnique({ where: { id: requested } });
    if (!audio?.storageKey || audio.status !== "READY") return Response.json({ error: "Soundtrack unavailable." }, { status: 404 });
    if (!audio.byteSize || audio.byteSize > 50 * 1024 * 1024) return Response.json({ error: "The soundtrack exceeds the browser export limit of 50 MB." }, { status: 413 });
    scratch = await mkdtemp(path.join(tmpdir(), "mvw-browser-audio-"));
    const file = path.join(scratch, "soundtrack");
    await createAssetStorage().downloadToFile(audio.storageKey, file);
    const bytes = await readFile(file);
    return new Response(bytes, { headers: { "content-type": audio.contentType ?? "application/octet-stream", "content-length": String(bytes.length), "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof WizardError) return Response.json({ error: "Project unavailable." }, { status: 404 });
    console.error("Browser soundtrack retrieval failed", error);
    return Response.json({ error: "Could not load the soundtrack." }, { status: 500 });
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined); }
}
