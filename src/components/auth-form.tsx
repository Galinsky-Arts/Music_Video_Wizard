"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/safe-next-path";

type AuthMode = "sign-in" | "sign-up";

function nextPath(): string {
  if (typeof window === "undefined") return "/app";
  return safeNextPath(new URLSearchParams(window.location.search).get("next"));
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();

    try {
      const result =
        mode === "sign-up"
          ? await authClient.signUp.email({
              name,
              email,
              password,
              callbackURL: nextPath()
            })
          : await authClient.signIn.email({
              email,
              password,
              callbackURL: nextPath()
            });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed.");
        return;
      }

      router.replace(nextPath() as "/app");
      router.refresh();
    } catch {
      setError("Authentication failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const isSignUp = mode === "sign-up";

  return (
    <main className="authShell">
      <section className="authCard">
        <Link className="brandLink" href="/">
          Music Video Wizard
        </Link>
        <p className="eyebrow">{isSignUp ? "Create account" : "Welcome back"}</p>
        <h1 className="authTitle">
          {isSignUp ? "Start directing." : "Continue your work."}
        </h1>
        <p className="authCopy">
          {isSignUp
            ? "Your account owns your projects, reusable creative library, and project history."
            : "Sign in to your projects and saved creative decisions."}
        </p>

        <form className="authForm" onSubmit={handleSubmit}>
          {isSignUp ? (
            <label>
              <span>Name</span>
              <input
                name="name"
                type="text"
                autoComplete="name"
                required
                maxLength={120}
              />
            </label>
          ) : null}

          <label>
            <span>Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </label>

          <label>
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete={isSignUp ? "new-password" : "current-password"}
              minLength={12}
              maxLength={128}
              required
            />
          </label>

          {error ? (
            <p className="formError" role="alert">
              {error}
            </p>
          ) : null}

          <button className="primaryButton" type="submit" disabled={pending}>
            {pending
              ? "Working…"
              : isSignUp
                ? "Create account"
                : "Sign in"}
          </button>
        </form>

        <p className="authSwitch">
          {isSignUp ? "Already have an account?" : "Need an account?"}{" "}
          <Link href={isSignUp ? "/sign-in" : "/sign-up"}>
            {isSignUp ? "Sign in" : "Create one"}
          </Link>
        </p>
      </section>
    </main>
  );
}
