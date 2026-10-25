import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";
import type { Role } from "../auth/auth.api";

type Choice = { organization: { id: string; name: string; slug: string }; role: Role };
function parseChoices(value: unknown): Choice[] {
  if (!Array.isArray(value) || !value.every((item: Choice) => item &&
    typeof item.organization?.id === "string" && /^[a-zA-Z0-9_-]+$/.test(item.organization.id) &&
    typeof item.organization.name === "string" && !!item.organization.name.trim() &&
    typeof item.organization.slug === "string" && ["OWNER", "ADMIN", "MEMBER"].includes(item.role)) ||
    new Set(value.map((item: Choice) => item.organization.id)).size !== value.length)
    throw new Error("Invalid organization choices");
  return value;
}

export function SwitchOrganizationPage() {
  const { session, request, switchOrganization } = useAuth();
  const navigate = useNavigate();
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [reload, setReload] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    return () => mutation.current?.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void request("/auth/organizations", { signal: controller.signal }).then((data) => {
      const next = parseChoices(data);
      if (!controller.signal.aborted) setChoices(next);
    }).catch(() => {
      if (!controller.signal.aborted) { setChoices(null); setError("Could not load your organizations. Try reloading the list."); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, reload]);

  async function select(organizationId: string) {
    if (mutation.current || loading) return;
    const controller = new AbortController();
    mutation.current = controller; setSaving(organizationId); setError("");
    try {
      await switchOrganization(organizationId, controller.signal);
      // Switch re-verifies the new session and remounts tenant pages. Never carry
      // an old conversation URL or draft into the selected team's dashboard.
      navigate("/dashboard", { replace: true });
    } catch (failure) {
      if (controller.signal.aborted) return;
      setChoices(null);
      setError(failure instanceof ApiError && failure.status === 404
        ? "That membership is no longer available. Reload your organizations."
        : "Could not switch organizations. Your current workspace is still selected. Reload to try again.");
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) setSaving("");
    }
  }

  return <section className="workspace" aria-labelledby="switch-heading">
    <p className="eyebrow">YOUR WORKSPACES</p>
    <h1 id="switch-heading" tabIndex={-1} ref={heading}>Switch organization</h1>
    <p>Current workspace: <strong>{session?.organization.name}</strong></p>
    <p>Choose a team you belong to. Documents, conversations and permissions follow the selected organization.</p>
    <p>Switching or leaving a page discards its unsaved drafts. Saved conversations stay in their original organization.</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {loading && <p role="status">Loading your organizations...</p>}
    {saving && <p role="status">Switching organization...</p>}
    {!loading && choices?.length === 0 && <p>You have no current memberships. Ask an organization manager for an invitation.</p>}
    {!loading && choices?.map((choice) => <article className="upload-panel member-card" key={choice.organization.id}>
      <h2>{choice.organization.name}</h2><p>Your role: {choice.role}</p>
      {choice.organization.id === session?.organization.id ? <p>Current organization</p> :
        <button className="secondary-button" disabled={!!saving} onClick={() => void select(choice.organization.id)}>Switch to {choice.organization.name}</button>}
    </article>)}
    <button className="secondary-button" disabled={loading || !!saving} onClick={() => {
      setChoices(null); setLoading(true); setError(""); setReload((n) => n + 1);
    }}>Reload organizations</button>
  </section>;
}
