import type { Prisma, ProjectCollaboratorRole, WorkspaceRole } from "@prisma/client";
import { db } from "@/lib/db";

export type ProjectAccessRole = "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER";

export interface ProjectCapabilities {
  role: ProjectAccessRole;
  canView: boolean;
  canEdit: boolean;
  canComment: boolean;
  canRequestApproval: boolean;
  canDecideApproval: boolean;
  canManageCollaborators: boolean;
}

/** Unexpired collaborator grant filter. */
export function activeCollaboratorWhere(userId: string, roles: ProjectCollaboratorRole[], now = new Date()): Prisma.ProjectCollaboratorWhereInput {
  return { userId, role: { in: roles }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/**
 * Prisma Project filter for write (creative editing) access: any member of
 * the owning workspace, or an unexpired EDITOR collaborator. Wrapped in AND
 * so it can be spread next to other filters without clobbering an OR.
 */
export function projectEditorWhere(userId: string, now = new Date()): Prisma.ProjectWhereInput {
  return {
    AND: [{
      OR: [
        { workspace: { memberships: { some: { userId } } } },
        { collaborators: { some: activeCollaboratorWhere(userId, ["EDITOR"], now) } }
      ]
    }]
  };
}

/** Project filter for read access (any role, unexpired). */
export function projectViewerWhere(userId: string, now = new Date()): Prisma.ProjectWhereInput {
  return {
    AND: [{
      OR: [
        { workspace: { memberships: { some: { userId } } } },
        { collaborators: { some: activeCollaboratorWhere(userId, ["EDITOR", "REVIEWER", "VIEWER"], now) } }
      ]
    }]
  };
}

export function capabilitiesFor(role: ProjectAccessRole): ProjectCapabilities {
  const owner = role === "OWNER";
  const editor = owner || role === "EDITOR";
  return {
    role,
    canView: true,
    canEdit: editor,
    canComment: editor || role === "REVIEWER",
    canRequestApproval: editor,
    canDecideApproval: owner || role === "REVIEWER",
    canManageCollaborators: owner
  };
}

/** Resolve the caller's effective role. Workspace OWNER/ADMIN manage; MEMBER edits. */
export function resolveProjectRole(input: {
  workspaceRole: WorkspaceRole | null;
  collaborator: { role: ProjectCollaboratorRole; expiresAt: Date | null } | null;
  now?: Date;
}): ProjectAccessRole | null {
  if (input.workspaceRole === "OWNER" || input.workspaceRole === "ADMIN") return "OWNER";
  if (input.workspaceRole === "MEMBER") return "EDITOR";
  const grant = input.collaborator;
  if (!grant) return null;
  if (grant.expiresAt && grant.expiresAt <= (input.now ?? new Date())) return null;
  return grant.role;
}

export async function getProjectAccess(userId: string, projectId: string, now = new Date()) {
  const project = await db.project.findFirst({
    where: { id: projectId, archivedAt: null },
    select: {
      id: true,
      title: true,
      workspaceId: true,
      workspace: { select: { memberships: { where: { userId }, select: { role: true } } } },
      collaborators: { where: { userId }, select: { role: true, expiresAt: true } }
    }
  });
  if (!project) return null;
  const role = resolveProjectRole({
    workspaceRole: project.workspace.memberships[0]?.role ?? null,
    collaborator: project.collaborators[0] ?? null,
    now
  });
  if (!role) return null;
  return { project: { id: project.id, title: project.title, workspaceId: project.workspaceId }, ...capabilitiesFor(role) };
}
