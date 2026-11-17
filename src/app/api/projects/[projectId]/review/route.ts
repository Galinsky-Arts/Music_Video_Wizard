import type { ReviewTargetKind } from "@prisma/client";
import { auth } from "@/lib/auth";
import { collaborationErrorResponse, int, readJson, str } from "@/lib/collaboration/http";
import {
  addComment, decideApproval, editComment, getReviewBoard, requestApproval, setCommentResolved
} from "@/lib/collaboration/service";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { projectId } = await context.params;
    return Response.json(await getReviewBoard(session.user.id, projectId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return collaborationErrorResponse(error, "Review board");
  }
}

export async function POST(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(request);
  if (!body) return Response.json({ error: "JSON body required." }, { status: 415 });
  const userId = session.user.id;
  try {
    const { projectId } = await context.params;
    const target = {
      targetKind: str(body.targetKind) as ReviewTargetKind,
      shotId: str(body.shotId) || null,
      timelineVersionId: str(body.timelineVersionId) || null
    };
    switch (str(body.action)) {
      case "comment":
        await addComment(userId, projectId, { ...target, body: body.body, timecodeMs: body.timecodeMs, parentCommentId: str(body.parentCommentId) || null });
        break;
      case "edit-comment":
        await editComment(userId, projectId, { commentId: str(body.commentId), body: body.body, expectedRevision: int(body.expectedRevision) });
        break;
      case "resolve-comment":
        await setCommentResolved(userId, projectId, { commentId: str(body.commentId), resolved: body.resolved !== false, expectedRevision: int(body.expectedRevision) });
        break;
      case "request-approval":
        await requestApproval(userId, projectId, { ...target, note: body.note });
        break;
      case "decide-approval":
        await decideApproval(userId, projectId, {
          approvalId: str(body.approvalId),
          decision: str(body.decision) as "APPROVED" | "CHANGES_REQUESTED" | "CANCELED",
          note: body.note,
          expectedRevision: int(body.expectedRevision)
        });
        break;
      default:
        return Response.json({ error: "Unsupported action." }, { status: 400 });
    }
    return Response.json(await getReviewBoard(userId, projectId));
  } catch (error) {
    return collaborationErrorResponse(error, "Review update");
  }
}
