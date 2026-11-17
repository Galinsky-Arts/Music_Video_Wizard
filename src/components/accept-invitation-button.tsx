"use client";

import { useState } from "react";

export function AcceptInvitationButton({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Unable to accept the invitation.");
        return;
      }
      window.location.assign(body.role === "EDITOR" ? `/app/projects/${body.projectId}/wizard` : `/app/projects/${body.projectId}/review`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button className="primaryButton" disabled={pending} onClick={accept} type="button">
        {pending ? "Joining…" : "Accept invitation"}
      </button>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </div>
  );
}
