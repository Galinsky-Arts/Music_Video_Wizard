import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ensurePersonalWorkspace } from "@/lib/workspaces";
import { SignOutButton } from "@/components/sign-out-button";
import { ProjectPackageRestore } from "@/components/project-package-restore";

export default async function AppHomePage() {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) redirect("/sign-in");

  const workspace = await ensurePersonalWorkspace(
    session.user.id,
    session.user.name
  );

  const projects = await db.project.findMany({
    where: {
      workspaceId: workspace.id,
      archivedAt: null
    },
    orderBy: { updatedAt: "desc" },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: {
          aspectRatio: true,
          frameRate: true
        }
      }
    }
  });

  return (
    <main className="dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">Music Video Wizard</p>
          <h1 className="dashboardTitle">Your studio</h1>
        </div>
        <div className="headerActions">
          <Link className="secondaryButton linkButton" href="/app/library">
            Creative Library
          </Link>
          <Link className="secondaryButton linkButton" href="/app/kits">
            Creative Kits
          </Link>
          <Link className="secondaryButton linkButton" href="/app/usage">
            Usage &amp; quotas
          </Link>
          <Link className="primaryButton linkButton" href="/app/projects/new">
            New project
          </Link>
          <SignOutButton />
        </div>
      </header>

      <section className="dashboardCard">
        <p className="dashboardLabel">Workspace</p>
        <p className="dashboardValue">{workspace.name}</p>
      </section>

      <ProjectPackageRestore />

      <section className="projectSection">
        <div className="sectionHeading">
          <h2>Projects</h2>
          <span>{projects.length}</span>
        </div>

        {projects.length === 0 ? (
          <div className="emptyState">
            <h3>No projects yet.</h3>
            <p>
              Create your first project by uploading the finished song. The
              wizard will build creative decisions on top of that master.
            </p>
            <Link className="primaryButton linkButton" href="/app/projects/new">
              Create first project
            </Link>
          </div>
        ) : (
          <div className="projectGrid">
            {projects.map((project) => {
              const version = project.versions[0];
              return (
                <Link
                  className="projectCard"
                  href={`/app/projects/${project.id}`}
                  key={project.id}
                >
                  <h3>{project.title}</h3>
                  <p>{project.description || "No description"}</p>
                  <div className="projectMeta">
                    <span>{version?.aspectRatio ?? "—"}</span>
                    <span>{version?.frameRate ?? "—"} fps</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
