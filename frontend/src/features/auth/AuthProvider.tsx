import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AuthContext } from "./auth.context";
import type { AuthState } from "./auth.context";
import { getIdentity } from "./auth.api";
import type { AuthSession } from "./auth.api";
import { apiRequest, ApiError } from "../../services/api";
import type { RequestOptions } from "../../services/api";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("anonymous");
  const [notice, setNotice] = useState("");
  const current = useRef<AuthSession | null>(null);
  const verification = useRef<AbortController | null>(null);
  const pending = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const cancelPending = useCallback(() => {
    for (const controller of pending.current) controller.abort();
    pending.current.clear();
  }, []);
  useEffect(
    () => () => {
      verification.current?.abort();
      cancelPending();
    },
    [cancelPending],
  );

  const clear = useCallback(
    (message = "") => {
      verification.current?.abort();
      cancelPending();
      generation.current++;
      current.current = null;
      setSession(null);
      setStatus("anonymous");
      setNotice(message);
    },
    [cancelPending],
  );

  useEffect(() => {
    if (!session?.expiresAt) return;
    const deadline = Date.parse(session.expiresAt);
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (current.current?.token === session.token && Date.now() >= deadline)
        clear("Your session has expired. Please sign in again.");
    };
    const schedule = () => {
      // Browsers cap timer delays; sleeping tabs may also delay callbacks. Check
      // the actual deadline again on wake/focus and before every API request.
      timer = setTimeout(
        () => {
          expire();
          if (Date.now() < deadline) schedule();
        },
        Math.min(Math.max(0, deadline - Date.now()), 2147483647),
      );
    };
    schedule();
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", expire);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [session?.token, session?.expiresAt, clear]);

  const updateOrganization = useCallback(
    (organization: AuthSession["organization"]) => {
      const owner = current.current;
      if (
        !owner ||
        owner.organization.id !== organization.id ||
        (owner.organization.name === organization.name &&
          owner.organization.slug === organization.slug)
      )
        return;
      // Synchronize the confirmed profile across Dashboard, Documents and Chat.
      // A profile response cannot switch the signed-in organization.
      const next = { ...owner, organization };
      current.current = next;
      setSession(next);
    },
    [],
  );

  async function verify(candidate: AuthSession) {
    verification.current?.abort();
    const controller = new AbortController();
    verification.current = controller;
    setStatus("checking");
    try {
      const identity = await getIdentity(candidate.token, controller.signal);
      if (controller.signal.aborted || current.current !== candidate) return;
      if (
        !identity ||
        identity.userId !== candidate.user.id ||
        identity.organizationId !== candidate.organization.id ||
        !["OWNER", "ADMIN", "MEMBER"].includes(identity.role)
      ) {
        clear("Your session could not be verified. Please sign in again.");
        return;
      }
      const expiresAt = identity.expiresAt ?? candidate.expiresAt;
      if (
        expiresAt !== undefined &&
        (!Number.isFinite(Date.parse(expiresAt)) ||
          Date.parse(expiresAt) <= Date.now())
      ) {
        clear("Your session has expired. Please sign in again.");
        return;
      }
      const verified = { ...candidate, role: identity.role, expiresAt };
      current.current = verified;
      setSession(verified);
      setStatus("authenticated");
    } catch (error) {
      if (controller.signal.aborted || current.current !== candidate) return;
      if (
        error instanceof ApiError &&
        error.code === "ORGANIZATION_ACCESS_REVOKED"
      ) {
        cancelPending();
        setStatus("restricted");
      } else if (error instanceof ApiError && error.status === 401)
        clear("Your session has expired. Please sign in again.");
      else setStatus("unavailable");
    }
  }

  function signIn(candidate: AuthSession) {
    if (
      !candidate ||
      typeof candidate.token !== "string" ||
      !candidate.token ||
      (candidate.expiresAt !== undefined &&
        (typeof candidate.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(candidate.expiresAt)))) ||
      !candidate.user?.id ||
      !candidate.organization?.id ||
      typeof candidate.user.name !== "string" ||
      typeof candidate.user.email !== "string" ||
      typeof candidate.organization.name !== "string"
    ) {
      throw new ApiError(
        "The server returned an invalid session. Please try again.",
        200,
        "INVALID_SESSION",
      );
    }
    cancelPending();
    generation.current++;
    current.current = candidate;
    setSession(candidate);
    setNotice("");
    void verify(candidate);
  }

  const request = useCallback(
    async <T,>(
      path: string,
      options: Omit<RequestOptions, "token"> = {},
    ): Promise<T> => {
      const owner = current.current;
      if (
        !owner ||
        (status !== "authenticated" &&
          !(
            status === "restricted" &&
            ["/auth/organizations", "/auth/switch-organization"].includes(path)
          ))
      )
        throw new ApiError("Please sign in to continue.", 401);
      if (owner.expiresAt && Date.parse(owner.expiresAt) <= Date.now()) {
        clear("Your session has expired. Please sign in again.");
        throw new ApiError("Please sign in again.", 401, "SESSION_EXPIRED");
      }
      const controller = new AbortController();
      pending.current.add(controller);
      try {
        const result = await apiRequest<T>(path, {
          ...options,
          token: owner.token,
          signal: options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal,
        });
        // A response started by a previous session cannot populate a new user's page.
        if (current.current?.token !== owner.token || controller.signal.aborted)
          throw new DOMException("Session changed", "AbortError");
        return result;
      } catch (error) {
        if (current.current?.token !== owner.token || controller.signal.aborted)
          throw new DOMException("Session changed", "AbortError");
        if (
          error instanceof ApiError &&
          [
            "ORGANIZATION_ACCESS_REVOKED",
            "DASHBOARD_MEMBERSHIP_REQUIRED",
            "AGENT_MEMBERSHIP_REQUIRED",
          ].includes(error.code ?? "")
        ) {
          cancelPending();
          setStatus("restricted");
        }
        if (error instanceof ApiError && error.status === 401)
          clear("Your session has expired. Please sign in again.");
        throw error;
      } finally {
        pending.current.delete(controller);
      }
    },
    [status, clear, cancelPending],
  );

  function signOut() {
    const owner = current.current;
    clear(); // Hide private views and abort reads immediately, including offline.
    const attempt = generation.current;
    if (!owner) return;
    void apiRequest<{ signedOut: boolean }>("/auth/logout", {
      method: "POST",
      token: owner.token,
      signal: AbortSignal.timeout(5000),
    })
      .then((result) => {
        if (result?.signedOut !== true)
          throw new Error("Invalid sign-out receipt");
      })
      .catch((error) => {
        // An expired/already-revoked token is unusable. Other failures are honest
        // local sign-out only; do not let a late reply overwrite a newer login.
        if (error instanceof ApiError && error.status === 401) return;
        if (!current.current && generation.current === attempt)
          setNotice(
            "Signed out on this browser. Server sign-out could not be confirmed.",
          );
      });
  }

  async function switchOrganization(
    organizationId: string,
    signal: AbortSignal,
  ) {
    const owner = current.current;
    if (!owner) throw new ApiError("Please sign in to continue.", 401);
    const candidate = await request<AuthSession>("/auth/switch-organization", {
      method: "POST",
      body: { organizationId },
      signal,
    });
    // A late switch must not overwrite a newer login, logout, or switch. Validate
    // both account and target before replacing the in-memory session.
    if (signal.aborted || current.current !== owner)
      throw new DOMException("Session changed", "AbortError");
    if (
      !candidate ||
      typeof candidate.token !== "string" ||
      !candidate.token ||
      candidate.user?.id !== owner.user.id ||
      candidate.organization?.id !== organizationId ||
      typeof candidate.user.name !== "string" ||
      typeof candidate.user.email !== "string" ||
      typeof candidate.organization.name !== "string" ||
      typeof candidate.organization.slug !== "string" ||
      !["OWNER", "ADMIN", "MEMBER"].includes(candidate.role)
    )
      throw new ApiError(
        "Invalid organization session.",
        200,
        "INVALID_SESSION",
      );
    signIn(candidate);
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        status,
        notice,
        signIn,
        signOut,
        switchOrganization,
        retry: () => {
          if (current.current) void verify(current.current);
        },
        request,
        updateOrganization,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
