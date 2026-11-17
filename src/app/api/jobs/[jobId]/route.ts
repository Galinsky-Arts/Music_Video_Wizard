import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projectEditorWhere } from "@/lib/collaboration/access";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  const job = await db.generationJob.findFirst({
    where: {
      id: jobId,
      OR: [{ workspace: { memberships: { some: { userId: session.user.id } } } }, { project: projectEditorWhere(session.user.id) }]
    },
    include: {
      events: {
        orderBy: { createdAt: "asc" },
        take: 250
      }
    }
  });

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  return Response.json({
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: job.status,
    providerKey: job.providerKey,
    modelKey: job.modelKey,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    progressPercent: job.progressPercent,
    progressMessage: job.progressMessage,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    cancelRequestedAt: job.cancelRequestedAt,
    events: job.events
  });
}
