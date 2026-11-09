import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getEnvironment } from "@/lib/env";
import { ensureWizardProgress } from "@/lib/wizard/service";
import { AssemblyImport } from "@/components/assembly-import";
export default async function AssemblyPage(props: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const { projectId } = await props.params;
  const project = await ensureWizardProgress({ userId: session.user.id, projectId });
  return <main className="dashboardShell">
    <Link href={`/app/projects/${projectId}/wizard`}>← Project</Link>
    <p className="eyebrow">Bring your own edit</p><h1 className="dashboardTitle">Finish an existing visual assembly.</h1>
    <p className="dashboardNote">Import locally made visuals, review the working cut, then render with the immutable soundtrack. Optional planning stages remain available and are not marked as completed by this import.</p>
    <section className="dashboardCard"><AssemblyImport projectId={projectId} revision={project.wizardProgress!.revision} maxBytes={getEnvironment().MAX_MEDIA_UPLOAD_BYTES}/></section>
  </main>;
}
