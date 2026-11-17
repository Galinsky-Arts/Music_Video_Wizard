import { auth } from "@/lib/auth";
import { collaborationErrorResponse, readJson, str } from "@/lib/collaboration/http";
import { acceptInvitation } from "@/lib/collaboration/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to accept this invitation." }, { status: 401 });
  const body = await readJson(request);
  if (!body) return Response.json({ error: "JSON body required." }, { status: 415 });
  try {
    return Response.json(await acceptInvitation({ id: session.user.id, email: session.user.email }, str(body.token)));
  } catch (error) {
    return collaborationErrorResponse(error, "Invitation acceptance");
  }
}
