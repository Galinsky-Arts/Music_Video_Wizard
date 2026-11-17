import type { ProjectCollaboratorRole } from "@prisma/client";
import { auth } from "@/lib/auth";
import { collaborationErrorResponse, readJson, str } from "@/lib/collaboration/http";
import { createInvitation, listCollaboration, revokeInvitation, updateCollaborator } from "@/lib/collaboration/service";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { projectId } = await context.params;
    return Response.json(await listCollaboration(session.user.id, projectId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return collaborationErrorResponse(error, "Collaborator list");
  }
}

export async function POST(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(request);
  if (!body) return Response.json({ error: "JSON body required." }, { status: 415 });
  try {
    const { projectId } = await context.params;
    const action = str(body.action);
    if (action === "invite") {
      const { invitation, token } = await createInvitation(session.user.id, projectId, {
        email: str(body.email), role: str(body.role) as ProjectCollaboratorRole, accessDays: body.accessDays
      });
      const origin = new URL(request.url).origin;
      return Response.json({ invitation, inviteUrl: origin + "/app/invite/" + token }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "revoke-invitation") {
      await revokeInvitation(session.user.id, projectId, str(body.invitationId));
    } else if (action === "update-collaborator") {
      await updateCollaborator(session.user.id, projectId, str(body.collaboratorId), {
        role: body.role ? (str(body.role) as ProjectCollaboratorRole) : undefined,
        accessDays: body.accessDays,
        remove: body.remove === true
      });
    } else {
      return Response.json({ error: "Unsupported action." }, { status: 400 });
    }
    return Response.json(await listCollaboration(session.user.id, projectId));
  } catch (error) {
    return collaborationErrorResponse(error, "Collaborator update");
  }
}
