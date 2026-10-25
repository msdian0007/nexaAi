import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { ApiError } from "../../services/api";
import { useAuth } from "../auth/auth.context";

type Role = "OWNER" | "ADMIN" | "MEMBER";
type Invitation = {
  id: string;
  organizationId: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
const validRole = (role: unknown): role is Role =>
  role === "OWNER" || role === "ADMIN" || role === "MEMBER";
function parseInvitations(
  value: unknown,
  organizationId: string,
): Invitation[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: Invitation) =>
        item &&
        /^[a-zA-Z0-9_-]+$/.test(item.id) &&
        item.organizationId === organizationId &&
        typeof item.email === "string" &&
        validRole(item.role) &&
        Number.isFinite(Date.parse(item.expiresAt)) &&
        Number.isFinite(Date.parse(item.createdAt)) &&
        (item.acceptedAt === null ||
          Number.isFinite(Date.parse(item.acceptedAt))) &&
        (item.revokedAt === null ||
          Number.isFinite(Date.parse(item.revokedAt))),
    )
  )
    throw new Error("Invalid invitations");
  return value;
}

export function InvitationsPage() {
  const { session, request } = useAuth();
  const [items, setItems] = useState<Invitation[] | null>(null);
  const [actorRole, setActorRole] = useState<Role | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const [days, setDays] = useState("7");
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const active = useRef<AbortController | null>(null);
  const organizationId = session?.organization.id ?? "";
  const owner = actorRole === "OWNER";
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ invitations: unknown; role: unknown }>(
      "/organizations/invitations",
      { signal: controller.signal },
    )
      .then((value) => {
        if (!value || !validRole(value.role) || value.role === "MEMBER")
          throw new Error("Invalid invitation permissions");
        const parsed = parseInvitations(value.invitations, organizationId);
        if (!controller.signal.aborted) {
          setItems(parsed);
          setActorRole(value.role);
          setNow(Date.now());
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Could not load invitations. Check your current permission and try again.",
          );
      });
    return () => controller.abort();
  }, [request, organizationId, reload]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    if (role === "OWNER" && !ownerConfirmed) {
      setError(
        "Confirm that this owner assignment cannot be undone in the current app.",
      );
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    setLink("");
    try {
      const value = await request<{ invitation: Invitation; token: string }>(
        "/organizations/invitations",
        {
          method: "POST",
          body: {
            email: email.trim().toLowerCase(),
            role: owner ? role : "MEMBER",
            expiresInDays: Number(days),
          },
          signal: controller.signal,
        },
      );
      if (
        !value ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
        parseInvitations([value.invitation], organizationId).length !== 1
      )
        throw new Error("Invalid invitation response");
      // The secret is shown only once; later list responses intentionally never contain it.
      setLink(
        `${window.location.origin}/invitations/accept?token=${encodeURIComponent(value.token)}`,
      );
      setEmail("");
      setOwnerConfirmed(false);
      setNotice(
        "Invitation created. Copy the link now; NexaAI will not show this secret again.",
      );
      setReload((n) => n + 1);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof ApiError && failure.status === 409
            ? "That person is already a member or already has an active invitation."
            : "Could not create the invitation. Check the details and your current permission.",
        );
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setLink("");
    try {
      await request(`/organizations/invitations/${id}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      setNotice("Invitation revoked. Its link can no longer be accepted.");
      setReload((n) => n + 1);
    } catch {
      if (!controller.signal.aborted)
        setError(
          "Could not revoke the invitation. Reload to check its current state.",
        );
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section
      className="workspace members-page"
      aria-labelledby="invitations-heading"
    >
      <p className="eyebrow">YOUR ORGANIZATION</p>
      <h1 id="invitations-heading">Invitations</h1>
      <p>
        <Link to="/organization/members">Members</Link>
      </p>
      <p>
        An invitation is a one-time, expiring link for one email address.
        Creating it does not send an email.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form className="upload-panel" onSubmit={create} aria-busy={busy}>
        <h2>Create invitation</h2>
        <label htmlFor="invite-email">Recipient email</label>
        <input
          id="invite-email"
          type="email"
          required
          maxLength={254}
          value={email}
          disabled={busy || actorRole === null}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="invite-role">Role after acceptance</label>
        <select
          id="invite-role"
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          {(owner ? ["MEMBER", "ADMIN", "OWNER"] : ["MEMBER"]).map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        {role === "OWNER" && (
          <label className="owner-confirmation">
            <input
              type="checkbox"
              checked={ownerConfirmed}
              disabled={busy}
              onChange={(e) => setOwnerConfirmed(e.target.checked)}
            />
            I understand that an accepted OWNER invitation grants full access
            and cannot currently be demoted or removed.
          </label>
        )}
        <label htmlFor="invite-days">Expires after</label>
        <select
          id="invite-days"
          value={days}
          disabled={busy}
          onChange={(e) => setDays(e.target.value)}
        >
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
        </select>
        <button className="primary-button" disabled={busy}>
          Create invitation
        </button>
      </form>
      {link && (
        <div className="upload-result">
          <label htmlFor="invitation-link">One-time invitation link</label>
          <input
            id="invitation-link"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
      <h2>Recent invitations</h2>
      {items === null ? (
        <p role="status">Loading invitations...</p>
      ) : items.length === 0 ? (
        <p>No invitations yet.</p>
      ) : (
        items.map((item) => {
          const state = item.acceptedAt
            ? "Accepted"
            : item.revokedAt
              ? "Revoked"
              : Date.parse(item.expiresAt) <= now
                ? "Expired"
                : "Active";
          return (
            <article className="upload-panel member-card" key={item.id}>
              <h3>{item.email}</h3>
              <p>
                {item.role} · {state} · expires{" "}
                {new Date(item.expiresAt).toLocaleString()}
              </p>
              {state === "Active" && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void revoke(item.id)}
                >
                  Revoke invitation for {item.email}
                </button>
              )}
            </article>
          );
        })
      )}
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => {
          setError("");
          setItems(null);
          setReload((n) => n + 1);
        }}
      >
        Reload invitations
      </button>
    </section>
  );
}

export function AcceptInvitationPage() {
  const { status, session, request } = useAuth();
  const token = new URLSearchParams(useLocation().search).get("token") ?? "";
  const [result, setResult] = useState<{
    organization: { id: string; name: string };
    role: Role;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (status !== "authenticated" || !session) {
    const returnTo = `/invitations/accept?token=${encodeURIComponent(token)}`;
    return (
      <section className="workspace">
        <h1>Accept organization invitation</h1>
        <p>Use the exact email address that received this invitation.</p>
        <Link to={`/login?returnTo=${encodeURIComponent(returnTo)}`}>
          Sign in
        </Link>
        {" · "}
        <Link to={`/register?returnTo=${encodeURIComponent(returnTo)}`}>
          Create account
        </Link>
      </section>
    );
  }
  async function accept() {
    if (busy || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError("This invitation link is invalid.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = await request<{
        organization: { id: string; name: string };
        role: Role;
      }>("/organizations/invitations/accept", {
        method: "POST",
        body: { token },
      });
      if (
        !value?.organization?.id ||
        !value.organization.name ||
        !validRole(value.role)
      )
        throw new Error("Invalid response");
      setResult(value);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "This invitation belongs to a different email address."
          : failure instanceof ApiError &&
              (failure.status === 409 || failure.status === 410)
            ? "This invitation is expired, revoked, already used, or you already belong to this organization."
            : "Could not accept this invitation.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace">
      <h1>Accept organization invitation</h1>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {result ? (
        <>
          <p role="status">
            Invitation accepted. You joined {result.organization.name} as{" "}
            {result.role}.
          </p>
          <p>
            Your membership is ready. Choose this team from the organization switcher.
          </p>
          <Link to="/organizations/switch">Choose organization</Link>
        </>
      ) : (
        <>
          <p>
            Signed in as {session.user.email}. Acceptance works only when this
            matches the invited email.
          </p>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void accept()}
          >
            {busy ? "Accepting..." : "Accept invitation"}
          </button>
        </>
      )}
    </section>
  );
}
