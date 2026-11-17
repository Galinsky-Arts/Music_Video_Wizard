import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProjectAccess } from "@/lib/collaboration/access";
import { DeliveryStudio } from "@/components/delivery-studio";

export default async function DeliveryPage(props: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  const { projectId } = await props.params;
  if (!session) redirect(`/sign-in?next=/app/projects/${projectId}/delivery`);
  const access = await getProjectAccess(session.user.id, projectId);
  if (!access) notFound();
  if (!access.canEdit) redirect(`/app/projects/${projectId}/review`);
  return (
    <main className="dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">Delivery &amp; performance</p>
          <h1 className="dashboardTitle">{access.project.title}</h1>
        </div>
        <div className="headerActions">
          <Link className="secondaryButton linkButton" href={`/app/projects/${projectId}/wizard`}>Open wizard</Link>
          <Link className="secondaryButton linkButton" href={`/app/projects/${projectId}/review`}>Review</Link>
        </div>
      </header>
      <DeliveryStudio projectId={projectId} />
    </main>
  );
}
