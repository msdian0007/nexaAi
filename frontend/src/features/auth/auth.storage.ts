import type { AuthSession, Role } from "./auth.api";

const STORAGE_KEY = "nexaai.session.v1";
const roles = new Set<Role>(["OWNER", "ADMIN", "MEMBER"]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function readStoredSession(): AuthSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !record(value) ||
      !text(value.token, 4096) ||
      !/^[A-Za-z0-9._-]+$/.test(value.token as string) ||
      !record(value.user) ||
      !text(value.user.id, 200) ||
      !text(value.user.name, 100) ||
      !text(value.user.email, 254) ||
      !record(value.organization) ||
      !text(value.organization.id, 200) ||
      !text(value.organization.name, 150) ||
      !text(value.organization.slug, 250) ||
      typeof value.role !== "string" ||
      !roles.has(value.role as Role) ||
      (value.expiresAt !== undefined &&
        (typeof value.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(value.expiresAt))))
    ) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // Expired credentials never enter React state or trigger a protected request.
    if (value.expiresAt && Date.parse(value.expiresAt as string) <= Date.now()) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value as unknown as AuthSession;
  } catch {
    // Storage can be unavailable or manually corrupted. Treat both as signed out.
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Nothing else can be cleared when browser storage is unavailable. */
    }
    return null;
  }
}

export function storeSession(session: AuthSession) {
  try {
    // sessionStorage survives refresh in this tab but is removed when the tab closes.
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Authentication still works in memory when a browser blocks storage.
  }
}

export function removeStoredSession() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* The in-memory session is still cleared by the caller. */
  }
}
