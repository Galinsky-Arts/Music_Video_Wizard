import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProjectAccess } from "@/lib/collaboration/access";
import { ReviewBoard } from "@/components/review-board";

export default async function ProjectReviewPage(props: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  const { projectId } = await props.params;
  if (!session) redirect(`/sign-in?next=/app/projects/${projectId}/review`);
  const access = await getProjectAccess(session.user.id, projectId);
  if (!access) notFound();

  return (
    <main className="dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">Review · {access.role.toLowerCase()}</p>
          <h1 className="dashboardTitle">{access.project.title}</h1>
        </div>
        <div className="headerActions">
          <Link className="secondaryButton linkButton" href="/app">Studio</Link>
          {access.canEdit ? (
            <Link className="secondaryButton linkButton" href={`/app/projects/${projectId}/wizard`}>Open wizard</Link>
          ) : null}
          {access.canManageCollaborators ? (
            <Link className="primaryButton linkButton" href={`/app/projects/${projectId}/share`}>Share</Link>
          ) : null}
        </div>
      </header>
      <ReviewBoard projectId={projectId} />
    </main>
  );
}
