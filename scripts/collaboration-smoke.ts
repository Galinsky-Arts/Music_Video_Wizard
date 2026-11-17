import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceRole } from "@prisma/client";
import { db } from "../src/lib/db";
import { getProjectAccess, projectEditorWhere, projectViewerWhere } from "../src/lib/collaboration/access";
import {
  acceptInvitation, addComment, CollaborationConflictError, CollaborationError, createInvitation, decideApproval,
  describeInvitation, editComment, getReviewBoard, listCollaboration, listSharedProjects, requestApproval,
  revokeInvitation, setCommentResolved, updateCollaborator
} from "../src/lib/collaboration/service";

async function rejectsWith(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: unknown) => error instanceof CollaborationError && error.status === status);
}

async function main() {
  const tag = randomUUID().slice(0, 8);
  const person = (name: string) => ({ id: randomUUID(), email: `${name}-${tag}@example.test` });
  const users = { owner: person("owner"), editor: person("editor"), reviewer: person("reviewer"), viewer: person("viewer"), stranger: person("stranger") };
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  try {
    for (const [name, user] of Object.entries(users)) await db.user.create({ data: { ...user, displayName: name } });
    await db.workspace.create({ data: { id: workspaceId, name: "Collab", memberships: { create: { userId: users.owner.id, role: WorkspaceRole.OWNER } } } });
    await db.project.create({ data: { id: projectId, workspaceId, title: "Shared video" } });
    await db.project.create({ data: { id: otherProjectId, workspaceId, title: "Private video" } });
    const shot = await db.shot.create({ data: { projectId } });
    const foreignShot = await db.shot.create({ data: { projectId: otherProjectId } });

    // Invitations: owner only, single use, email bound, revocable.
    await rejectsWith(createInvitation(users.stranger.id, projectId, { email: users.editor.email, role: "EDITOR" }), 404);
    const editorInvite = await createInvitation(users.owner.id, projectId, { email: users.editor.email.toUpperCase(), role: "EDITOR" });
    const reviewerInvite = await createInvitation(users.owner.id, projectId, { email: users.reviewer.email, role: "REVIEWER", accessDays: 30 });
    const viewerInvite = await createInvitation(users.owner.id, projectId, { email: users.viewer.email, role: "VIEWER" });
    const revoked = await createInvitation(users.owner.id, projectId, { email: users.stranger.email, role: "VIEWER" });
    assert.equal((await db.projectInvitation.findUniqueOrThrow({ where: { id: editorInvite.invitation.id } })).tokenHash.includes(editorInvite.token), false);
    assert.equal((await describeInvitation(editorInvite.token))?.state, "pending");
    await rejectsWith(acceptInvitation(users.stranger, editorInvite.token), 403);
    const accepted = await Promise.allSettled(Array.from({ length: 3 }, () => acceptInvitation(users.editor, editorInvite.token)));
    assert.equal(accepted.filter((result) => result.status === "fulfilled").length, 1);
    assert.ok(accepted.filter((result) => result.status === "rejected").every((result) => (result as PromiseRejectedResult).reason instanceof CollaborationConflictError));
    await acceptInvitation(users.reviewer, reviewerInvite.token);
    await acceptInvitation(users.viewer, viewerInvite.token);
    await revokeInvitation(users.owner.id, projectId, revoked.invitation.id);
    await rejectsWith(acceptInvitation(users.stranger, revoked.token), 410);
    await db.projectInvitation.update({ where: { id: editorInvite.invitation.id }, data: { acceptedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    await rejectsWith(acceptInvitation(users.editor, editorInvite.token), 410);

    // Access scoping: editors get creative write access to this project only.
    const canWrite = async (userId: string, id = projectId) => Boolean(await db.project.findFirst({ where: { id, ...projectEditorWhere(userId) } }));
    const canRead = async (userId: string) => Boolean(await db.project.findFirst({ where: { id: projectId, ...projectViewerWhere(userId) } }));
    assert.equal(await canWrite(users.owner.id), true);
    assert.equal(await canWrite(users.editor.id), true);
    assert.equal(await canWrite(users.editor.id, otherProjectId), false);
    assert.equal(await canWrite(users.reviewer.id), false);
    assert.equal(await canWrite(users.viewer.id), false);
    assert.equal(await canRead(users.viewer.id), true);
    assert.equal(await canRead(users.stranger.id), false);
    assert.equal(await getProjectAccess(users.stranger.id, projectId), null);
    assert.equal((await getProjectAccess(users.reviewer.id, projectId))?.role, "REVIEWER");
    assert.deepEqual((await listSharedProjects(users.editor.id)).map((entry) => entry.project.id), [projectId]);
    const viewerList = await listCollaboration(users.viewer.id, projectId);
    assert.ok(viewerList.collaborators.every((entry) => entry.user.email === null));
    assert.equal(viewerList.invitations.length, 0);
    await rejectsWith(updateCollaborator(users.editor.id, projectId, viewerList.collaborators[0]!.id, { remove: true }), 403);

    // Comments: timecoded, threaded, permissioned, optimistic concurrency.
    const comment = await addComment(users.reviewer.id, projectId, { targetKind: "SHOT", shotId: shot.id, body: "Hold the wide a beat longer", timecodeMs: 12_500 });
    await addComment(users.editor.id, projectId, { targetKind: "PROJECT", body: "Reply", parentCommentId: comment.id });
    await rejectsWith(addComment(users.viewer.id, projectId, { targetKind: "PROJECT", body: "nope" }), 403);
    await rejectsWith(addComment(users.reviewer.id, projectId, { targetKind: "SHOT", shotId: foreignShot.id, body: "cross project" }), 400);
    await rejectsWith(addComment(users.reviewer.id, projectId, { targetKind: "PROJECT", body: "x", timecodeMs: -1 }), 400);
    await rejectsWith(editComment(users.editor.id, projectId, { commentId: comment.id, body: "hijack", expectedRevision: 0 }), 403);
    await editComment(users.reviewer.id, projectId, { commentId: comment.id, body: "Hold the wide two beats", expectedRevision: 0 });
    await rejectsWith(editComment(users.reviewer.id, projectId, { commentId: comment.id, body: "stale", expectedRevision: 0 }), 409);
    await setCommentResolved(users.editor.id, projectId, { commentId: comment.id, resolved: true, expectedRevision: 1 });
    await rejectsWith(setCommentResolved(users.reviewer.id, projectId, { commentId: comment.id, resolved: false, expectedRevision: 1 }), 409);

    // Approvals: editors request, reviewers decide once; no self-approval.
    await rejectsWith(requestApproval(users.reviewer.id, projectId, { targetKind: "SHOT", shotId: shot.id }), 403);
    const approval = await requestApproval(users.editor.id, projectId, { targetKind: "SHOT", shotId: shot.id, note: "Final framing" });
    await rejectsWith(requestApproval(users.editor.id, projectId, { targetKind: "SHOT", shotId: shot.id }), 409);
    await rejectsWith(decideApproval(users.editor.id, projectId, { approvalId: approval.id, decision: "APPROVED", expectedRevision: 0 }), 403);
    await rejectsWith(decideApproval(users.viewer.id, projectId, { approvalId: approval.id, decision: "APPROVED", expectedRevision: 0 }), 403);
    const decisions = await Promise.allSettled([
      decideApproval(users.reviewer.id, projectId, { approvalId: approval.id, decision: "APPROVED", expectedRevision: 0 }),
      decideApproval(users.owner.id, projectId, { approvalId: approval.id, decision: "CHANGES_REQUESTED", note: "Tighter", expectedRevision: 0 })
    ]);
    assert.equal(decisions.filter((result) => result.status === "fulfilled").length, 1);
    const board = await getReviewBoard(users.viewer.id, projectId);
    assert.equal(board.comments.length, 2);
    assert.equal(board.comments[0]!.timecodeMs, 12_500);
    assert.notEqual(board.approvals[0]!.status, "PENDING");
    assert.equal(board.access.canComment, false);

    // Access expiration is enforced at query time.
    await db.projectCollaborator.updateMany({ where: { projectId, userId: users.editor.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await canWrite(users.editor.id), false);
    assert.equal(await getProjectAccess(users.editor.id, projectId), null);
    await rejectsWith(getReviewBoard(users.editor.id, projectId), 404);
    assert.equal((await listSharedProjects(users.editor.id)).length, 0);
    console.log("Collaboration smoke passed: invites, roles, scoping, comments, approvals, concurrency, expiry.");
  } finally {
    await db.reviewComment.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
    await db.reviewApprovalRequest.deleteMany({ where: { projectId } });
    await db.projectInvitation.deleteMany({ where: { projectId } });
    await db.projectCollaborator.deleteMany({ where: { projectId } });
    await db.shot.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
    await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
