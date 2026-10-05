import { useState } from "react";
import type { AuthSession } from "./features/auth/auth.api";
import { AuthForm } from "./features/auth/AuthForm";
import "./App.css";

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>{" "}
          NexaAI
        </span>
        {session && (
          <button className="secondary-button" onClick={() => setSession(null)}>
            Sign out
          </button>
        )}
      </header>
      <main>
        {!session ? (
          <AuthForm onAuthenticated={setSession} />
        ) : (
          <section className="workspace" aria-labelledby="welcome-heading">
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1
              id="welcome-heading"
              tabIndex={-1}
              ref={(element) => element?.focus()}
            >
              Welcome, {session.user.name}
            </h1>
            <p>You’re signed in to {session.organization.name}.</p>
            <dl className="account-details">
              <div>
                <dt>Email</dt>
                <dd>{session.user.email}</dd>
              </div>
              <div>
                <dt>Organization</dt>
                <dd>{session.organization.name}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{session.role}</dd>
              </div>
            </dl>
            <div className="workspace-note">
              <h2>Your knowledge workspace</h2>
              <p>
                Document management and chat will be available here as we build
                the next steps.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
