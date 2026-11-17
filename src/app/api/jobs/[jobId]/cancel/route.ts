import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { cancelGenerationJob } from "@/lib/jobs/service";
import { projectEditorWhere } from "@/lib/collaboration/access";

export async function POST(
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
    select: { id: true }
  });

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const cancelled = await cancelGenerationJob(job.id);
  if (!cancelled) {
    return Response.json(
      { error: "Job is no longer cancellable." },
      { status: 409 }
    );
  }

  return Response.json({ id: job.id, status: "CANCELLED" });
}
