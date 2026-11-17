import { createHash, randomBytes } from "node:crypto";
import type { ProjectCollaboratorRole, ReviewTargetKind } from "@prisma/client";
import { db } from "@/lib/db";
import { getProjectAccess } from "./access";

export class CollaborationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
export class CollaborationConflictError extends CollaborationError {
  constructor(message: string) {
    super(message, 409);
  }
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COMMENT_LENGTH = 4000;

export function hashInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function requireAccess(userId: string, projectId: string) {
  const access = await getProjectAccess(userId, projectId);
  if (!access) throw new CollaborationError("Project not found.", 404);
  return access;
}

function normalizeEmail(email: string) {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 320) throw new CollaborationError("Enter a valid email address.");
  return value;
}

function accessExpiry(days: unknown): Date | null {
  if (days === undefined || days === null || days === "") return null;
  const value = Number(days);
  if (!Number.isInteger(value) || value < 1 || value > 365) throw new CollaborationError("Access duration must be 1–365 days.");
  return new Date(Date.now() + value * 24 * 60 * 60 * 1000);
}

export async function listCollaboration(userId: string, projectId: string) {
  const access = await requireAccess(userId, projectId);
  const [collaborators, invitations] = await Promise.all([
    db.projectCollaborator.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, expiresAt: true, createdAt: true, user: { select: { id: true, displayName: true, email: true } } }
    }),
    access.canManageCollaborators
      ? db.projectInvitation.findMany({
          where: { projectId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: "desc" },
          select: { id: true, email: true, role: true, expiresAt: true, accessExpiresAt: true, createdAt: true }
        })
      : Promise.resolve([])
  ]);
  return {
    access,
    // Non-managers see names and roles only, not email addresses.
    collaborators: collaborators.map((entry) => ({
      ...entry,
      user: { id: entry.user.id, displayName: entry.user.displayName, email: access.canManageCollaborators ? entry.user.email : null }
    })),
    invitations
  };
}

/** Returns the raw token once; only its hash is stored. */
export async function createInvitation(userId: string, projectId: string, input: { email: string; role: ProjectCollaboratorRole; accessDays?: unknown }) {
  const access = await requireAccess(userId, projectId);
  if (!access.canManageCollaborators) throw new CollaborationError("Only the project owner can invite collaborators.", 403);
  if (!["EDITOR", "REVIEWER", "VIEWER"].includes(input.role)) throw new CollaborationError("Unknown role.");
  const email = normalizeEmail(input.email);
  const token = randomBytes(32).toString("base64url");
  const invitation = await db.projectInvitation.create({
    data: {
      projectId,
      email,
      role: input.role,
      tokenHash: hashInvitationToken(token),
      invitedByUserId: userId,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      accessExpiresAt: accessExpiry(input.accessDays)
    },
    select: { id: true, email: true, role: true, expiresAt: true, accessExpiresAt: true }
  });
  return { invitation, token };
}

export async function revokeInvitation(userId: string, projectId: string, invitationId: string) {
  const access = await requireAccess(userId, projectId);
  if (!access.canManageCollaborators) throw new CollaborationError("Only the project owner can manage invitations.", 403);
  const result = await db.projectInvitation.updateMany({
    where: { id: invitationId, projectId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  if (result.count !== 1) throw new CollaborationConflictError("Invitation is no longer pending.");
}

export async function updateCollaborator(userId: string, projectId: string, collaboratorId: string, input: { role?: ProjectCollaboratorRole; accessDays?: unknown; remove?: boolean }) {
  const access = await requireAccess(userId, projectId);
  if (!access.canManageCollaborators) throw new CollaborationError("Only the project owner can manage collaborators.", 403);
  if (input.remove) {
    const removed = await db.projectCollaborator.deleteMany({ where: { id: collaboratorId, projectId } });
    if (removed.count !== 1) throw new CollaborationError("Collaborator not found.", 404);
    return;
  }
  if (input.role && !["EDITOR", "REVIEWER", "VIEWER"].includes(input.role)) throw new CollaborationError("Unknown role.");
  const updated = await db.projectCollaborator.updateMany({
    where: { id: collaboratorId, projectId },
    data: { ...(input.role ? { role: input.role } : {}), ...(input.accessDays !== undefined ? { expiresAt: accessExpiry(input.accessDays) } : {}) }
  });
  if (updated.count !== 1) throw new CollaborationError("Collaborator not found.", 404);
}

export async function describeInvitation(token: string) {
  const invitation = await db.projectInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: { email: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true, project: { select: { id: true, title: true, archivedAt: true } } }
  });
  if (!invitation || invitation.project.archivedAt) return null;
  const state = invitation.revokedAt ? "revoked" : invitation.acceptedAt ? "accepted" : invitation.expiresAt <= new Date() ? "expired" : "pending";
  return { state, email: invitation.email, role: invitation.role, projectId: invitation.project.id, projectTitle: invitation.project.title };
}

/** Single use: concurrent acceptance of one token succeeds at most once. */
export async function acceptInvitation(user: { id: string; email: string }, token: string) {
  const tokenHash = hashInvitationToken(token);
  return db.$transaction(async (tx) => {
    const invitation = await tx.projectInvitation.findUnique({ where: { tokenHash } });
    if (!invitation) throw new CollaborationError("Invitation not found.", 404);
    if (invitation.revokedAt) throw new CollaborationError("This invitation was revoked.", 410);
    if (invitation.acceptedAt) throw new CollaborationConflictError("This invitation was already used.");
    if (invitation.expiresAt <= new Date()) throw new CollaborationError("This invitation has expired.", 410);
    if (invitation.email !== user.email.trim().toLowerCase()) {
      throw new CollaborationError("Sign in with the invited email address to accept.", 403);
    }
    const claimed = await tx.projectInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedByUserId: user.id }
    });
    if (claimed.count !== 1) throw new CollaborationConflictError("This invitation was already used.");
    const project = await tx.project.findUniqueOrThrow({ where: { id: invitation.projectId }, select: { workspace: { select: { memberships: { where: { userId: user.id }, select: { id: true } } } } } });
    if (project.workspace.memberships.length === 0) {
      await tx.projectCollaborator.upsert({
        where: { projectId_userId: { projectId: invitation.projectId, userId: user.id } },
        update: { role: invitation.role, expiresAt: invitation.accessExpiresAt },
        create: { projectId: invitation.projectId, userId: user.id, role: invitation.role, invitedByUserId: invitation.invitedByUserId, expiresAt: invitation.accessExpiresAt }
      });
    }
    return { projectId: invitation.projectId, role: invitation.role };
  });
}

export async function listSharedProjects(userId: string) {
  const now = new Date();
  return db.projectCollaborator.findMany({
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], project: { archivedAt: null } },
    orderBy: { updatedAt: "desc" },
    select: { role: true, expiresAt: true, project: { select: { id: true, title: true, description: true } } }
  });
}

// ---------- Review board: comments and approvals ----------

type Target = { targetKind: ReviewTargetKind; shotId?: string | null; timelineVersionId?: string | null };

async function assertTarget(projectId: string, target: Target) {
  if (target.targetKind === "PROJECT") return { shotId: null, timelineVersionId: null };
  if (target.targetKind === "SHOT") {
    if (!target.shotId || !(await db.shot.findFirst({ where: { id: target.shotId, projectId }, select: { id: true } }))) {
      throw new CollaborationError("Shot not found in this project.");
    }
    return { shotId: target.shotId, timelineVersionId: null };
  }
  if (target.targetKind === "CUT") {
    if (!target.timelineVersionId || !(await db.timelineVersion.findFirst({ where: { id: target.timelineVersionId, timeline: { projectId } }, select: { id: true } }))) {
      throw new CollaborationError("Cut not found in this project.");
    }
    return { shotId: null, timelineVersionId: target.timelineVersionId };
  }
  throw new CollaborationError("Unknown review target.");
}

function cleanBody(body: unknown, field = "Comment") {
  if (typeof body !== "string" || !body.trim()) throw new CollaborationError(field + " is required.");
  if (body.length > MAX_COMMENT_LENGTH) throw new CollaborationError(field + " is too long.");
  return body.trim();
}

function cleanTimecode(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0 || ms > 6 * 60 * 60 * 1000) throw new CollaborationError("Timecode is out of range.");
  return ms;
}

export async function getReviewBoard(userId: string, projectId: string) {
  const access = await requireAccess(userId, projectId);
  const [shots, timelines, comments, approvals] = await Promise.all([
    db.shot.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: {
        id: true,
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { versionNumber: true, label: true, plannedStartMs: true, plannedEndMs: true, subject: true, action: true, dramaticPurpose: true }
        }
      }
    }),
    db.timeline.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 5,
          select: { id: true, versionNumber: true, lifecycle: true, createdAt: true, _count: { select: { items: true } } }
        }
      }
    }),
    db.reviewComment.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      take: 2000,
      select: {
        id: true, targetKind: true, shotId: true, timelineVersionId: true, timecodeMs: true, body: true, parentCommentId: true,
        revision: true, editedAt: true, resolvedAt: true, createdAt: true, authorUserId: true, author: { select: { displayName: true } }
      }
    }),
    db.reviewApprovalRequest.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true, targetKind: true, shotId: true, timelineVersionId: true, note: true, status: true, revision: true,
        decidedAt: true, decisionNote: true, createdAt: true, requestedByUserId: true,
        requestedBy: { select: { displayName: true } }, decidedBy: { select: { displayName: true } }
      }
    })
  ]);
  const durations = await db.timelineItem.groupBy({
    by: ["timelineVersionId"],
    where: { timelineVersionId: { in: timelines.flatMap((timeline) => timeline.versions.map((version) => version.id)) } },
    _max: { timelineEndMs: true }
  });
  const durationByVersion = new Map(durations.map((row) => [row.timelineVersionId, row._max.timelineEndMs ?? 0]));
  return {
    access,
    viewerId: userId,
    shots: shots.map((shot, index) => ({ id: shot.id, index: index + 1, ...shot.versions[0] })),
    cuts: timelines.flatMap((timeline) => timeline.versions.map((version) => ({
      id: version.id,
      name: timeline.name,
      kind: timeline.kind,
      versionNumber: version.versionNumber,
      lifecycle: version.lifecycle,
      createdAt: version.createdAt,
      itemCount: version._count.items,
      durationMs: durationByVersion.get(version.id) ?? 0
    }))),
    comments,
    approvals
  };
}

export async function addComment(userId: string, projectId: string, input: Target & { body: unknown; timecodeMs?: unknown; parentCommentId?: string | null }) {
  const access = await requireAccess(userId, projectId);
  if (!access.canComment) throw new CollaborationError("Your role can view but not comment.", 403);
  let target: { shotId: string | null; timelineVersionId: string | null } = await assertTarget(projectId, input);
  let targetKind = input.targetKind;
  if (input.parentCommentId) {
    const parent = await db.reviewComment.findFirst({ where: { id: input.parentCommentId, projectId }, select: { targetKind: true, shotId: true, timelineVersionId: true } });
    if (!parent) throw new CollaborationError("Thread not found.");
    targetKind = parent.targetKind;
    target = { shotId: parent.shotId, timelineVersionId: parent.timelineVersionId };
  }
  return db.reviewComment.create({
    data: {
      projectId, authorUserId: userId, targetKind, ...target,
      timecodeMs: cleanTimecode(input.timecodeMs), body: cleanBody(input.body), parentCommentId: input.parentCommentId ?? null
    },
    select: { id: true }
  });
}

/** Optimistic concurrency: edits and resolution must name the revision they saw. */
export async function editComment(userId: string, projectId: string, input: { commentId: string; body: unknown; expectedRevision: number }) {
  const access = await requireAccess(userId, projectId);
  if (!access.canComment) throw new CollaborationError("Your role cannot edit comments.", 403);
  const updated = await db.reviewComment.updateMany({
    where: { id: input.commentId, projectId, authorUserId: userId, revision: input.expectedRevision },
    data: { body: cleanBody(input.body), editedAt: new Date(), revision: { increment: 1 } }
  });
  if (updated.count !== 1) {
    const exists = await db.reviewComment.findFirst({ where: { id: input.commentId, projectId, authorUserId: userId }, select: { id: true } });
    if (!exists) throw new CollaborationError("Only the author can edit a comment.", 403);
    throw new CollaborationConflictError("This comment changed since you loaded it. Reload and try again.");
  }
}

export async function setCommentResolved(userId: string, projectId: string, input: { commentId: string; resolved: boolean; expectedRevision: number }) {
  const access = await requireAccess(userId, projectId);
  if (!access.canComment) throw new CollaborationError("Your role cannot resolve comments.", 403);
  const updated = await db.reviewComment.updateMany({
    where: { id: input.commentId, projectId, parentCommentId: null, revision: input.expectedRevision },
    data: input.resolved
      ? { resolvedAt: new Date(), resolvedByUserId: userId, revision: { increment: 1 } }
      : { resolvedAt: null, resolvedByUserId: null, revision: { increment: 1 } }
  });
  if (updated.count !== 1) throw new CollaborationConflictError("This thread changed since you loaded it. Reload and try again.");
}

export async function requestApproval(userId: string, projectId: string, input: Target & { note?: unknown }) {
  const access = await requireAccess(userId, projectId);
  if (!access.canRequestApproval) throw new CollaborationError("Only editors can request approval.", 403);
  const target = await assertTarget(projectId, input);
  const pending = await db.reviewApprovalRequest.findFirst({ where: { projectId, targetKind: input.targetKind, ...target, status: "PENDING" }, select: { id: true } });
  if (pending) throw new CollaborationConflictError("An approval request is already pending for this item.");
  return db.reviewApprovalRequest.create({
    data: { projectId, requestedByUserId: userId, targetKind: input.targetKind, ...target, note: input.note ? cleanBody(input.note, "Note") : null },
    select: { id: true }
  });
}

export async function decideApproval(userId: string, projectId: string, input: { approvalId: string; decision: "APPROVED" | "CHANGES_REQUESTED" | "CANCELED"; note?: unknown; expectedRevision: number }) {
  const access = await requireAccess(userId, projectId);
  const request = await db.reviewApprovalRequest.findFirst({ where: { id: input.approvalId, projectId }, select: { requestedByUserId: true } });
  if (!request) throw new CollaborationError("Approval request not found.", 404);
  if (input.decision === "CANCELED") {
    if (request.requestedByUserId !== userId && access.role !== "OWNER") throw new CollaborationError("Only the requester or owner can cancel.", 403);
  } else {
    if (!access.canDecideApproval) throw new CollaborationError("Only reviewers or the owner can approve.", 403);
    if (request.requestedByUserId === userId && access.role !== "OWNER") throw new CollaborationError("You cannot approve your own request.", 403);
    if (!["APPROVED", "CHANGES_REQUESTED"].includes(input.decision)) throw new CollaborationError("Unknown decision.");
  }
  const updated = await db.reviewApprovalRequest.updateMany({
    where: { id: input.approvalId, projectId, status: "PENDING", revision: input.expectedRevision },
    data: {
      status: input.decision, decidedByUserId: userId, decidedAt: new Date(), revision: { increment: 1 },
      decisionNote: input.note ? cleanBody(input.note, "Note") : null
    }
  });
  if (updated.count !== 1) throw new CollaborationConflictError("This request was already decided or changed. Reload to see the latest state.");
}
