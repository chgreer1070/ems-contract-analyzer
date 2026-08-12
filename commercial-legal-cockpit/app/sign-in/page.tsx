import { MicrosoftSignInButton } from "@/components/MicrosoftSignInButton";

export default function SignInPage() {
  return <main className="signin-shell">
    <section className="signin-card">
      <div className="eyebrow">EMS COMMERCIAL LEGAL COCKPIT</div>
      <h1>Secure legal workspace</h1>
      <p>Use your approved Microsoft Entra ID account. Authentication confirms identity; matter-level authorization is enforced separately on the server.</p>
      <MicrosoftSignInButton />
      <div className="signin-note">Production access remains disabled until the Entra tenant, PostgreSQL database, private Blob store, roles, and security gates are configured.</div>
    </section>
  </main>;
}
