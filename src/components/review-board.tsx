"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { formatTimecode, parseTimecode } from "@/lib/collaboration/timecode";

type TargetKind = "PROJECT" | "SHOT" | "CUT";
type Comment = {
  id: string; targetKind: TargetKind; shotId: string | null; timelineVersionId: string | null; timecodeMs: number | null;
  body: string; parentCommentId: string | null; revision: number; editedAt: string | null; resolvedAt: string | null;
  createdAt: string; authorUserId: string | null; author: { displayName: string } | null;
};
type Approval = {
  id: string; targetKind: TargetKind; shotId: string | null; timelineVersionId: string | null; note: string | null;
  status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "CANCELED"; revision: number; decisionNote: string | null;
  createdAt: string; requestedByUserId: string | null; requestedBy: { displayName: string } | null; decidedBy: { displayName: string } | null;
};
type Board = {
  viewerId: string;
  access: { role: string; canComment: boolean; canRequestApproval: boolean; canDecideApproval: boolean };
  shots: { id: string; index: number; label?: string | null; plannedStartMs?: number | null; plannedEndMs?: number | null; subject?: string | null; action?: string | null; versionNumber?: number }[];
  cuts: { id: string; name: string; kind: string; versionNumber: number; lifecycle: string; itemCount: number; durationMs: number }[];
  comments: Comment[];
  approvals: Approval[];
};
type Target = { targetKind: TargetKind; shotId?: string; timelineVersionId?: string };

function sameTarget(item: { targetKind: TargetKind; shotId: string | null; timelineVersionId: string | null }, target: Target) {
  return item.targetKind === target.targetKind && (item.shotId ?? undefined) === target.shotId && (item.timelineVersionId ?? undefined) === target.timelineVersionId;
}

export function ReviewBoard({ projectId }: { projectId: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/projects/${projectId}/review`;

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setBoard(body);
    else setError(body.error ?? "Unable to load the review board.");
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(payload: Record<string, unknown>) {
    setError(null);
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setBoard(body);
      return true;
    }
    setError(body.error ?? "Request failed.");
    if (response.status === 409) await load();
    return false;
  }

  if (!board) return <p role="status">{error ?? "Loading review board…"}</p>;

  const pending = board.approvals.filter((approval) => approval.status === "PENDING");

  function targetLabel(item: { targetKind: TargetKind; shotId: string | null; timelineVersionId: string | null }) {
    if (item.targetKind === "SHOT") {
      const shot = board!.shots.find((entry) => entry.id === item.shotId);
      return `Shot ${shot?.index ?? "?"}${shot?.label ? ` — ${shot.label}` : ""}`;
    }
    if (item.targetKind === "CUT") {
      const cut = board!.cuts.find((entry) => entry.id === item.timelineVersionId);
      return cut ? `${cut.name} v${cut.versionNumber}` : "Cut";
    }
    return "Whole project";
  }

  function Thread({ target }: { target: Target }) {
    const comments = board!.comments.filter((comment) => sameTarget(comment, target));
    const roots = comments.filter((comment) => !comment.parentCommentId);
    const approvals = board!.approvals.filter((approval) => sameTarget(approval, target));
    const latestApproval = approvals[0];
    return (
      <div className="reviewThread">
        {latestApproval ? <p className="dashboardLabel">Approval: {latestApproval.status.replace("_", " ").toLowerCase()}</p> : null}
        {roots.length === 0 ? <p>No comments.</p> : (
          <ol>
            {roots.map((comment) => (
              <li key={comment.id}>
                <CommentView comment={comment} />
                <ol>
                  {comments.filter((reply) => reply.parentCommentId === comment.id).map((reply) => (
                    <li key={reply.id}><CommentView comment={reply} /></li>
                  ))}
                </ol>
                {board!.access.canComment ? <CommentForm target={target} parentCommentId={comment.id} compact /> : null}
              </li>
            ))}
          </ol>
        )}
        {board!.access.canComment ? <CommentForm target={target} /> : null}
        {board!.access.canRequestApproval && !approvals.some((approval) => approval.status === "PENDING") ? (
          <button className="secondaryButton" type="button" onClick={() => void act({ action: "request-approval", ...target, note: window.prompt("Note for reviewers (optional)") || undefined })}>
            Request approval
          </button>
        ) : null}
      </div>
    );
  }

  function CommentView({ comment }: { comment: Comment }) {
    const own = comment.authorUserId === board!.viewerId;
    return (
      <div className={comment.resolvedAt ? "reviewComment resolved" : "reviewComment"}>
        <p>
          <strong>{comment.author?.displayName ?? "Former collaborator"}</strong>
          {comment.timecodeMs !== null ? <> · <code>{formatTimecode(comment.timecodeMs)}</code></> : null}
          {comment.editedAt ? " · edited" : ""}
          {comment.resolvedAt ? " · resolved" : ""}
        </p>
        <p>{comment.body}</p>
        {own ? (
          <button className="linkLikeButton" type="button" onClick={() => {
            const body = window.prompt("Edit comment", comment.body);
            if (body) void act({ action: "edit-comment", commentId: comment.id, body, expectedRevision: comment.revision });
          }}>Edit</button>
        ) : null}{" "}
        {board!.access.canComment && !comment.parentCommentId ? (
          <button className="linkLikeButton" type="button" onClick={() => void act({ action: "resolve-comment", commentId: comment.id, resolved: !comment.resolvedAt, expectedRevision: comment.revision })}>
            {comment.resolvedAt ? "Reopen" : "Resolve"}
          </button>
        ) : null}
      </div>
    );
  }

  function CommentForm({ target, parentCommentId, compact }: { target: Target; parentCommentId?: string; compact?: boolean }) {
    async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const timecodeMs = parseTimecode(String(form.get("timecode") ?? ""));
      if (Number.isNaN(timecodeMs)) {
        setError("Timecode must look like 1:23.500");
        return;
      }
      if (await act({ action: "comment", ...target, parentCommentId, body: form.get("body"), timecodeMs })) formElement.reset();
    }
    return (
      <form className="reviewCommentForm" onSubmit={submit} aria-label={parentCommentId ? "Reply" : "Add comment"}>
        <label>
          <span className={compact ? "visuallyHidden" : undefined}>{parentCommentId ? "Reply" : "Comment"}</span>
          <textarea name="body" required maxLength={4000} rows={compact ? 1 : 2} placeholder={parentCommentId ? "Reply…" : "Add a comment…"} />
        </label>
        {!parentCommentId ? <label>Timecode <input name="timecode" placeholder="m:ss.mmm" size={9} /></label> : null}
        <button className="secondaryButton" type="submit">{parentCommentId ? "Reply" : "Comment"}</button>
      </form>
    );
  }

  return (
    <div className="projectSection">
      {error ? <p className="formError" role="alert">{error}</p> : null}

      <section className="dashboardCard" aria-labelledby="approvals-heading">
        <h2 id="approvals-heading">Approval requests</h2>
        {pending.length === 0 ? <p>No pending approvals.</p> : (
          <ul>
            {pending.map((approval) => (
              <li key={approval.id}>
                <strong>{targetLabel(approval)}</strong> — requested by {approval.requestedBy?.displayName ?? "someone"}
                {approval.note ? `: “${approval.note}”` : ""}{" "}
                {board.access.canDecideApproval && (approval.requestedByUserId !== board.viewerId || board.access.role === "OWNER") ? (
                  <>
                    <button className="primaryButton" type="button" onClick={() => void act({ action: "decide-approval", approvalId: approval.id, decision: "APPROVED", expectedRevision: approval.revision })}>Approve</button>{" "}
                    <button className="secondaryButton" type="button" onClick={() => {
                      const note = window.prompt("What needs to change?");
                      if (note) void act({ action: "decide-approval", approvalId: approval.id, decision: "CHANGES_REQUESTED", note, expectedRevision: approval.revision });
                    }}>Request changes</button>{" "}
                  </>
                ) : null}
                {approval.requestedByUserId === board.viewerId || board.access.role === "OWNER" ? (
                  <button className="secondaryButton" type="button" onClick={() => void act({ action: "decide-approval", approvalId: approval.id, decision: "CANCELED", expectedRevision: approval.revision })}>Cancel</button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {board.approvals.some((approval) => approval.status !== "PENDING") ? (
          <details>
            <summary>Decided</summary>
            <ul>
              {board.approvals.filter((approval) => approval.status !== "PENDING").map((approval) => (
                <li key={approval.id}>{targetLabel(approval)} — {approval.status.replace("_", " ").toLowerCase()} by {approval.decidedBy?.displayName ?? "—"}{approval.decisionNote ? `: “${approval.decisionNote}”` : ""}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="dashboardCard" aria-labelledby="project-comments-heading">
        <h2 id="project-comments-heading">Whole project</h2>
        <Thread target={{ targetKind: "PROJECT" }} />
      </section>

      <section className="dashboardCard" aria-labelledby="cuts-heading">
        <h2 id="cuts-heading">Cuts</h2>
        {board.cuts.length === 0 ? <p>No cuts yet. Build the first cut in the wizard.</p> : board.cuts.map((cut) => (
          <details key={cut.id}>
            <summary>{cut.name} v{cut.versionNumber} · {cut.kind.toLowerCase().replace("_", " ")} · {cut.itemCount} items · {formatTimecode(cut.durationMs)} · {cut.lifecycle.toLowerCase()} · {board.comments.filter((comment) => comment.timelineVersionId === cut.id).length} comments</summary>
            <Thread target={{ targetKind: "CUT", timelineVersionId: cut.id }} />
          </details>
        ))}
      </section>

      <section className="dashboardCard" aria-labelledby="shots-heading">
        <h2 id="shots-heading">Shots</h2>
        {board.shots.length === 0 ? <p>No shots yet.</p> : board.shots.map((shot) => (
          <details key={shot.id}>
            <summary>
              Shot {shot.index}{shot.label ? ` — ${shot.label}` : ""} · {formatTimecode(shot.plannedStartMs)}–{formatTimecode(shot.plannedEndMs)} · {board.comments.filter((comment) => comment.shotId === shot.id).length} comments
            </summary>
            {shot.subject || shot.action ? <p>{[shot.subject, shot.action].filter(Boolean).join(" — ")}</p> : null}
            <Thread target={{ targetKind: "SHOT", shotId: shot.id }} />
          </details>
        ))}
      </section>
    </div>
  );
}
