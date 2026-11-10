import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getEnvironment } from "@/lib/env";
import { getNarrativePlan } from "@/lib/narrative/service";
import { NarrativeEditor } from "@/components/narrative-editor";
export default async function NarrativePage(props: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() }); if (!session) redirect("/sign-in");
  const { projectId } = await props.params, state = await getNarrativePlan({ userId: session.user.id, projectId });
  return <main className="dashboardShell"><Link href={`/app/projects/${projectId}/wizard`}>← Project</Link><p className="eyebrow">Narrative studio</p>
    <h1 className="dashboardTitle">Give the music a story.</h1><p className="dashboardNote">An original Star Trek fan-story template with character continuity, cause and consequence, and full-song shot prompts. Edit the exported JSON to replace the cast or story.</p>
    <section className="dashboardCard"><NarrativeEditor projectId={projectId} audioId={state.audioId} durationMs={state.durationMs} versionId={state.versionId} savedPlan={state.plan} provider={getEnvironment().VIDEO_GENERATION_PROVIDER}/></section>
  </main>;
}
