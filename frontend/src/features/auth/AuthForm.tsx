import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { login, register } from "./auth.api";
import type { AuthSession } from "./auth.api";
import { ApiError } from "../../services/api";
import { useNavigate } from "react-router-dom";

export function AuthForm({
  onAuthenticated,
  mode,
}: {
  onAuthenticated: (session: AuthSession) => void;
  mode: "login" | "register";
}) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const registering = mode === "register";

  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);
  useEffect(() => {
    heading.current?.focus();
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeRequest.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const email = String(fields.get("email") ?? "").trim();
    const password = String(fields.get("password") ?? "");
    const name = String(fields.get("name") ?? "").trim();
    const organizationName = String(
      fields.get("organizationName") ?? "",
    ).trim();
    if (registering && (!name || !organizationName)) {
      setError("Enter your name and organization name.");
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setError("");
    try {
      const session = registering
        ? await register(
            { email, password, name, organizationName },
            controller.signal,
          )
        : await login({ email, password }, controller.signal);
      if (!controller.signal.aborted) {
        form.reset();
        onAuthenticated(session);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(
          failure instanceof ApiError
            ? failure.message
            : "Something went wrong. Please try again.",
        );
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <section className="auth-layout">
      <div className="auth-intro">
        <p className="eyebrow">KNOWLEDGE, CONNECTED</p>
        <h1>
          Your team’s knowledge.
          <br />
          One place to start.
        </h1>
        <p>
          Bring your organization’s documents and questions together in NexaAI.
        </p>
      </div>
      <div className="auth-card">
        <h2 ref={heading} tabIndex={-1}>
          {registering ? "Create your workspace" : "Welcome back"}
        </h2>
        <p>
          {registering
            ? "Create an account and a new organization."
            : "Sign in to your organization’s workspace."}
        </p>
        <form key={mode} onSubmit={submit} aria-busy={pending}>
          <fieldset disabled={pending}>
            <legend className="sr-only">
              {registering ? "Registration details" : "Login details"}
            </legend>
            {registering && (
              <>
                <label htmlFor="name">Full name</label>
                <input
                  id="name"
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                />
                <label htmlFor="organizationName">Organization name</label>
                <input
                  id="organizationName"
                  name="organizationName"
                  autoComplete="organization"
                  required
                  maxLength={150}
                />
              </>
            )}
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              required
              minLength={registering ? 8 : undefined}
              aria-describedby={registering ? "password-help" : undefined}
            />
            {registering && (
              <small id="password-help">Use at least 8 characters.</small>
            )}
            <button className="primary-button" type="submit">
              {pending
                ? registering
                  ? "Creating account…"
                  : "Signing in…"
                : registering
                  ? "Create account"
                  : "Sign in"}
            </button>
          </fieldset>
          {pending && (
            <p className="request-status" role="status">
              Connecting to your workspace…
            </p>
          )}
          {error && (
            <p
              className="form-error"
              ref={errorElement}
              role="alert"
              tabIndex={-1}
            >
              {error}
            </p>
          )}
        </form>
        <p className="auth-switch">
          {registering ? "Already have an account?" : "New to NexaAI?"}{" "}
          <button
            type="button"
            disabled={pending}
            className="text-button"
            onClick={() => {
              setError("");
              navigate(registering ? "/login" : "/register");
            }}
          >
            {registering ? "Sign in" : "Create an account"}
          </button>
        </p>
        <p className="session-note">
          You’ll need to sign in again if you refresh or close this page.
        </p>
      </div>
    </section>
  );
}
