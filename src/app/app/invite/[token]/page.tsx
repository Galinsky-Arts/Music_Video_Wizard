import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { describeInvitation } from "@/lib/collaboration/service";
import { AcceptInvitationButton } from "@/components/accept-invitation-button";

export default async function InvitePage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const [session, invitation] = await Promise.all([
    auth.api.getSession({ headers: await headers() }),
    describeInvitation(token)
  ]);
  const next = encodeURIComponent(`/app/invite/${token}`);

  return (
    <main className="authShell">
      <section className="authCard">
        <Link className="brandLink" href="/">Music Video Wizard</Link>
        {!invitation ? (
          <p>This invitation link is not valid.</p>
        ) : invitation.state !== "pending" ? (
          <p>This invitation has {invitation.state === "accepted" ? "already been used" : `been ${invitation.state}`}. Ask the project owner for a new link.</p>
        ) : (
          <>
            <h1>Join “{invitation.projectTitle}”</h1>
            <p>You were invited as <strong>{invitation.role.toLowerCase()}</strong> ({invitation.email}).</p>
            {session ? (
              <AcceptInvitationButton token={token} />
            ) : (
              <p>
                <Link href={`/sign-in?next=${next}` as "/sign-in"}>Sign in</Link> or{" "}
                <Link href={`/sign-up?next=${next}` as "/sign-up"}>create an account</Link> with {invitation.email} to accept.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
