"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Role = "EDITOR" | "REVIEWER" | "VIEWER";
type State = {
  collaborators: { id: string; role: Role; expiresAt: string | null; user: { displayName: string; email: string | null } }[];
  invitations: { id: string; email: string; role: Role; expiresAt: string; accessExpiresAt: string | null }[];
};

const roles: Role[] = ["EDITOR", "REVIEWER", "VIEWER"];

export function CollaboratorManager({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const endpoint = `/api/projects/${projectId}/collaborators`;

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const body = await response.json();
    if (response.ok) setState(body);
    else setError(body.error ?? "Unable to load collaborators.");
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(payload: Record<string, unknown>) {
    setError(null);
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "Request failed.");
      return null;
    }
    return body;
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = await post({
      action: "invite",
      email: form.get("email"),
      role: form.get("role"),
      accessDays: form.get("accessDays") || undefined
    });
    if (body) {
      setInviteUrl(body.inviteUrl);
      formElement.reset();
      await load();
    }
  }

  async function mutate(payload: Record<string, unknown>) {
    const body = await post(payload);
    if (body) setState(body);
  }

  return (
    <section className="projectSection">
      <form className="dashboardCard" onSubmit={invite} aria-label="Invite a collaborator">
        <h2>Invite</h2>
        <label>Email <input name="email" type="email" required autoComplete="off" /></label>{" "}
        <label>Role{" "}
          <select name="role" defaultValue="REVIEWER">
            {roles.map((role) => <option key={role} value={role}>{role.toLowerCase()}</option>)}
          </select>
        </label>{" "}
        <label>Access ends after (days, optional) <input name="accessDays" type="number" min={1} max={365} /></label>{" "}
        <button className="primaryButton" type="submit">Create invite link</button>
        {inviteUrl ? (
          <p role="status">
            Send this single-use link to the invitee (shown once): <code>{inviteUrl}</code>{" "}
            <button className="secondaryButton" type="button" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>Copy</button>
          </p>
        ) : null}
      </form>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      <div className="dashboardCard">
        <h2>Collaborators</h2>
        {!state ? <p>Loading…</p> : state.collaborators.length === 0 ? <p>No collaborators yet.</p> : (
          <ul>
            {state.collaborators.map((entry) => (
              <li key={entry.id}>
                {entry.user.displayName} {entry.user.email ? `(${entry.user.email})` : ""} —{" "}
                <select aria-label={`Role for ${entry.user.displayName}`} value={entry.role} onChange={(event) => void mutate({ action: "update-collaborator", collaboratorId: entry.id, role: event.target.value })}>
                  {roles.map((role) => <option key={role} value={role}>{role.toLowerCase()}</option>)}
                </select>
                {entry.expiresAt ? ` · access ends ${new Date(entry.expiresAt).toLocaleDateString()}` : ""}{" "}
                <button className="secondaryButton" type="button" onClick={() => void mutate({ action: "update-collaborator", collaboratorId: entry.id, remove: true })}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <h2>Pending invitations</h2>
        {!state || state.invitations.length === 0 ? <p>None.</p> : (
          <ul>
            {state.invitations.map((invitation) => (
              <li key={invitation.id}>
                {invitation.email} — {invitation.role.toLowerCase()} · link expires {new Date(invitation.expiresAt).toLocaleDateString()}{" "}
                <button className="secondaryButton" type="button" onClick={() => void mutate({ action: "revoke-invitation", invitationId: invitation.id })}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
