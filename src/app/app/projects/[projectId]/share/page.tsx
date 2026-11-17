import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProjectAccess } from "@/lib/collaboration/access";
import { CollaboratorManager } from "@/components/collaborator-manager";

export default async function ProjectSharePage(props: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  const { projectId } = await props.params;
  if (!session) redirect(`/sign-in?next=/app/projects/${projectId}/share`);
  const access = await getProjectAccess(session.user.id, projectId);
  if (!access) notFound();
  if (!access.canManageCollaborators) redirect(`/app/projects/${projectId}/review`);

  return (
    <main className="dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">Share project</p>
          <h1 className="dashboardTitle">{access.project.title}</h1>
        </div>
        <div className="headerActions">
          <Link className="secondaryButton linkButton" href={`/app/projects/${projectId}/review`}>Review board</Link>
          <Link className="secondaryButton linkButton" href={`/app/projects/${projectId}/wizard`}>Open wizard</Link>
        </div>
      </header>
      <section className="dashboardCard">
        <p className="dashboardLabel">Roles</p>
        <ul>
          <li><strong>Editor</strong> — works in every wizard step, generates and edits, requests approval.</li>
          <li><strong>Reviewer</strong> — views the review board, comments on shots and cuts with timecodes, approves or requests changes.</li>
          <li><strong>Viewer</strong> — read-only review board and comments.</li>
        </ul>
        <p>Invite links are single-use, expire after 7 days, and must be accepted by an account with the invited email. You can also set an access end date.</p>
      </section>
      <CollaboratorManager projectId={projectId} />
    </main>
  );
}
