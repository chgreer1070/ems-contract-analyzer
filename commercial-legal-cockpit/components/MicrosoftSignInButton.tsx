"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function MicrosoftSignInButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.social({ provider: "microsoft", callbackURL: "/" });
      if (result?.error) setError(result.error.message || "Microsoft sign-in failed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microsoft sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="signin-actions">
    <button className="primary" type="button" onClick={signIn} disabled={busy}>{busy ? "Redirecting…" : "Sign in with Microsoft"}</button>
    {error && <p className="signin-error">{error}</p>}
  </div>;
}
