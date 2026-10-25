import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";

type Profile = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  canEdit: boolean;
};
function parseProfile(value: unknown, expectedId: string): Profile {
  const p = value as Profile | null;
  if (
    !p ||
    p.id !== expectedId ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    typeof p.slug !== "string" ||
    !["OWNER", "ADMIN", "MEMBER"].includes(p.role) ||
    p.canEdit !== (p.role === "OWNER") ||
    !Number.isFinite(Date.parse(p.createdAt)) ||
    !Number.isFinite(Date.parse(p.updatedAt))
  )
    throw new Error("Invalid organization profile");
  return p;
}
function validateName(name: string) {
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return !name.trim() || name.trim().length > 100 || hasControlCharacter
    ? "Enter a name with 1 to 100 characters, without line breaks or control characters."
    : "";
}

export function OrganizationPage() {
  const { session, request, updateOrganization } = useAuth();
  const organizationId = session?.organization.id ?? "";
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const saveRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    return () => saveRequest.current?.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void request("/organizations/profile", { signal: controller.signal })
      .then((value) => {
        const next = parseProfile(value, organizationId);
        if (controller.signal.aborted) return;
        setProfile(next);
        setName(next.name);
        setError("");
        updateOrganization({ id: next.id, name: next.name, slug: next.slug });
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setProfile(null);
        setError(
          failure instanceof ApiError && failure.status === 403
            ? "You no longer have access to this organization."
            : "Could not load the organization profile. Try again.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [organizationId, reload, request, updateOrganization]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!profile?.canEdit || saveRequest.current) return;
    const invalid = validateName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await request("/organizations/profile", {
        method: "PATCH",
        body: { name: name.trim() },
        signal: controller.signal,
      });
      const next = parseProfile(result, organizationId);
      if (controller.signal.aborted) return;
      setProfile(next);
      setName(next.name);
      updateOrganization({ id: next.id, name: next.name, slug: next.slug });
      setNotice("Organization name saved.");
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 403) {
        // Permissions may have changed after the form loaded; the server decides.
        setProfile(null);
        setError(
          "Your permission to edit this profile has changed. Reload the profile.",
        );
      } else
        setError(
          "Could not confirm the save. Your draft is preserved; reload the profile to check its saved name.",
        );
    } finally {
      if (saveRequest.current === controller) saveRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  return (
    <section className="workspace" aria-labelledby="organization-heading">
      <p className="eyebrow">YOUR ORGANIZATION</p>
      <h1 id="organization-heading" tabIndex={-1} ref={heading}>
        Organization profile
      </h1>
      <p>View your organization details. Only an owner can change its name.</p>
      {loading && <p role="status">Loading organization profile...</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {profile && !loading && (
        <>
          <dl className="account-details">
            <div>
              <dt>Organization name</dt>
              <dd>{profile.name}</dd>
            </div>
            <div>
              <dt>Your current role</dt>
              <dd>{profile.role}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(profile.createdAt).toLocaleDateString()}</dd>
            </div>
          </dl>
          {profile.canEdit ? (
            <form className="upload-panel" onSubmit={save} aria-busy={saving}>
              <label htmlFor="organization-name">
                Organization display name
              </label>
              <input
                id="organization-name"
                value={name}
                maxLength={100}
                disabled={saving}
                onChange={(e) => {
                  setName(e.target.value);
                  setNotice("");
                }}
                aria-describedby="organization-name-help"
              />
              <p id="organization-name-help">
                1–100 characters. Renaming keeps your existing members,
                documents and conversations.
              </p>
              <button
                className="primary-button"
                disabled={
                  saving || !!validateName(name) || name.trim() === profile.name
                }
              >
                {saving ? "Saving..." : "Save organization name"}
              </button>
            </form>
          ) : (
            <p>
              This profile is read-only for your role. Ask an owner to update
              the name.
            </p>
          )}
        </>
      )}
      <button
        className="secondary-button"
        disabled={loading || saving}
        onClick={() => {
          setLoading(true);
          setError("");
          setNotice("");
          setReload((value) => value + 1);
        }}
      >
        Reload profile
      </button>
    </section>
  );
}
