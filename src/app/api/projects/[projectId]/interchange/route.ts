import { auth } from "@/lib/auth";
import { buildInterchange, DeliveryError } from "@/lib/delivery/service";
import { attachmentDisposition } from "@/lib/storage/disposition";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const format = new URL(request.url).searchParams.get("format");
  if (format !== "fcpxml" && format !== "edl" && format !== "manifest") return Response.json({ error: "format must be fcpxml, edl or manifest." }, { status: 400 });
  try {
    const { projectId } = await context.params;
    const file = await buildInterchange({ userId: session.user.id, projectId, format });
    return new Response(file.body, { headers: { "Content-Type": file.contentType + "; charset=utf-8", "Content-Disposition": attachmentDisposition(file.fileName), "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof DeliveryError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /Lock the Refinement/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    console.error("Interchange export failed");
    return Response.json({ error: "Interchange export failed." }, { status: 500 });
  }
}
