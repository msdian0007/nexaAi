import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";

type Role = "OWNER" | "ADMIN" | "MEMBER";
type Member = {
  id: string;
  userId: string;
  organizationId: string;
  role: Role;
  user: { id: string; name: string; email: string };
};
type Action =
  | { kind: "add"; email: string; role: Role }
  | { kind: "role"; member: Member; role: Role }
  | { kind: "remove"; member: Member };
const roles: Role[] = ["MEMBER", "ADMIN", "OWNER"];

function parseMembers(
  value: unknown,
  organizationId: string,
  userId: string,
): Member[] {
  // Check tenant and identity before rendering data or enabling member actions.
  if (
    !Array.isArray(value) ||
    !value.every(
      (m: Member) =>
        m &&
        typeof m.id === "string" &&
        /^[a-zA-Z0-9_-]+$/.test(m.id) &&
        m.organizationId === organizationId &&
        typeof m.userId === "string" &&
        roles.includes(m.role) &&
        m.user?.id === m.userId &&
        typeof m.user?.name === "string" &&
        typeof m.user?.email === "string",
    ) ||
    new Set(value.map((m: Member) => m.id)).size !== value.length ||
    new Set(value.map((m: Member) => m.userId)).size !== value.length ||
    !value.some((m: Member) => m.userId === userId)
  )
    throw new Error("Invalid member list");
  return value;
}

export function MembersPage() {
  const { session, request } = useAuth();
  const organizationId = session?.organization.id ?? "";
  const userId = session?.user.id ?? "";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const [pending, setPending] = useState<Action | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  // The fresh membership controls the screen; the backend checks again on every write.
  const actorRole = members?.find((m) => m.userId === userId)?.role;
  const manager = actorRole === "OWNER" || actorRole === "ADMIN";
  const busy = loading || saving || !!pending;

  useEffect(() => {
    heading.current?.focus();
    return () => mutation.current?.abort();
  }, []);
  useEffect(() => {
    if (pending) confirmation.current?.focus();
  }, [pending]);
  useEffect(() => {
    const controller = new AbortController();
    void request("/organizations/members", { signal: controller.signal })
      .then((data) => {
        const list = parseMembers(data, organizationId, userId);
        if (!controller.signal.aborted) setMembers(list);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMembers(null);
          setError(
            "Could not load members. Reload members to check your access and try again.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request, organizationId, userId, reload]);

  function refresh() {
    setMembers(null);
    setPending(null);
    setRole("MEMBER");
    setLoading(true);
    setReload((n) => n + 1);
  }

  async function execute(action: Action) {
    if (mutation.current || !manager || loading) return;
    const controller = new AbortController();
    mutation.current = controller;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      // URLs use the membership ID, not the account's user ID.
      const path =
        action.kind === "add"
          ? "/organizations/members"
          : `/organizations/members/${action.member.id}${action.kind === "role" ? "/role" : ""}`;
      await request(path, {
        method:
          action.kind === "add"
            ? "POST"
            : action.kind === "role"
              ? "PATCH"
              : "DELETE",
        body:
          action.kind === "add"
            ? { email: action.email, role: action.role }
            : action.kind === "role"
              ? { role: action.role }
              : undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setNotice(
        action.kind === "add"
          ? "Member added."
          : action.kind === "role"
            ? "Member role updated."
            : "Membership and its private conversations removed.",
      );
      if (action.kind === "add") setEmail("");
      refresh();
    } catch (failure) {
      if (controller.signal.aborted) return;
      const status = failure instanceof ApiError ? failure.status : 0;
      setError(
        status === 403
          ? "Your permissions have changed. Reload members before continuing."
          : status === 404 && action.kind === "add"
            ? "No registered account was found for that email. Check it, then reload members."
            : status === 409
              ? "This membership already exists or the requested change is protected. Reload members."
              : "Could not confirm the change. Reload members to check the saved result before trying again.",
      );
      // An interrupted response may still have committed. Require a fresh read, never retry a write automatically.
      setMembers(null);
      setPending(null);
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <section
      className="workspace members-page"
      aria-labelledby="members-heading"
    >
      <p className="eyebrow">YOUR ORGANIZATION</p>
      <h1 id="members-heading" tabIndex={-1} ref={heading}>
        Organization members
      </h1>
      <p>
        <Link to="/organization">Organization profile</Link>
        {manager && (
          <>
            {" "}
            · <Link to="/organization/invitations">Invitations</Link>
          </>
        )}
      </p>
      <p>
        Members can view teammates. Administrators can add and remove regular
        members. Owners can also manage administrator roles.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Loading members...</p>}
      {members && !loading && (
        <>
          <p>
            Your current role: <strong>{actorRole}</strong>
          </p>
          {manager && (
            <form
              className="upload-panel"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !email.trim()) return;
                const action: Action = {
                  kind: "add",
                  email: email.trim().toLowerCase(),
                  role: actorRole === "OWNER" ? role : "MEMBER",
                };
                if (action.role === "OWNER") setPending(action);
                else void execute(action);
              }}
            >
              <h2>Add a registered user</h2>
              <p>
                This email must already have a NexaAI account. This does not
                send an invitation.
              </p>
              <label htmlFor="member-email">Registered email</label>
              <input
                id="member-email"
                type="email"
                required
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
              <label htmlFor="new-member-role">New member role</label>
              <select
                id="new-member-role"
                value={role}
                disabled={busy}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {(actorRole === "OWNER" ? roles : ["MEMBER"]).map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <button className="primary-button" disabled={busy}>
                Add member
              </button>
            </form>
          )}
          {members.map((m) => (
            <article
              className="upload-panel member-card"
              key={m.id}
              aria-label={`Member ${m.user.email}`}
            >
              <h2>
                {m.user.name}
                {m.userId === userId ? " (you)" : ""}
              </h2>
              <p>{m.user.email}</p>
              <p>Role: {m.role}</p>
              {m.role === "OWNER" ? (
                <p>
                  Protected owner: this membership cannot be changed or removed.
                </p>
              ) : (
                <>
                  {actorRole === "OWNER" && (
                    <label>
                      Change role for {m.user.email}
                      <select
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          setPending({
                            kind: "role",
                            member: m,
                            role: e.target.value as Role,
                          })
                        }
                      >
                        {roles.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {manager &&
                    (actorRole === "OWNER" || m.role === "MEMBER") && (
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() =>
                          setPending({ kind: "remove", member: m })
                        }
                      >
                        Remove {m.user.email}
                      </button>
                    )}
                </>
              )}
            </article>
          ))}
        </>
      )}
      {/* Destructive removal and permanent owner assignments require a separate, explicit confirmation. */}
      {pending && (
        <section
          className="upload-panel"
          aria-labelledby="confirm-member-heading"
        >
          <h2 id="confirm-member-heading" tabIndex={-1} ref={confirmation}>
            Confirm membership change
          </h2>
          {pending.kind === "remove" ? (
            <p>
              Remove {pending.member.user.name} ({pending.member.user.email})?
              This permanently deletes their private conversations and messages
              in this organization. Their account and memberships in other
              organizations remain.
            </p>
          ) : (
            <>
              <p>
                {pending.kind === "add"
                  ? `Add ${pending.email}`
                  : `Change ${pending.member.user.email}`}{" "}
                as {pending.role}?
              </p>
              {pending.role === "OWNER" && (
                <p>
                  Owners have full membership-management access. Once assigned,
                  this owner cannot be demoted or removed through NexaAI. This
                  change cannot be undone here.
                </p>
              )}
            </>
          )}
          <button
            className="primary-button"
            disabled={saving}
            onClick={() => void execute(pending)}
          >
            {saving ? "Saving..." : "Confirm change"}
          </button>{" "}
          <button
            className="secondary-button"
            disabled={saving}
            onClick={() => {
              setPending(null);
              heading.current?.focus();
            }}
          >
            Cancel
          </button>
        </section>
      )}
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => {
          setError("");
          setNotice("");
          refresh();
        }}
      >
        Reload members
      </button>
    </section>
  );
}
