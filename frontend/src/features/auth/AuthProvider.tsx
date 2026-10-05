import { useEffect, useRef, useState } from "react";
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
  useEffect(() => () => verification.current?.abort(), []);

  function clear(message = "") {
    verification.current?.abort();
    current.current = null;
    setSession(null);
    setStatus("anonymous");
    setNotice(message);
  }

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
      const verified = { ...candidate, role: identity.role };
      current.current = verified;
      setSession(verified);
      setStatus("authenticated");
    } catch (error) {
      if (controller.signal.aborted || current.current !== candidate) return;
      if (error instanceof ApiError && error.status === 401)
        clear("Your session has expired. Please sign in again.");
      else setStatus("unavailable");
    }
  }

  function signIn(candidate: AuthSession) {
    if (
      !candidate ||
      typeof candidate.token !== "string" ||
      !candidate.token ||
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
    current.current = candidate;
    setSession(candidate);
    setNotice("");
    void verify(candidate);
  }

  async function request<T>(
    path: string,
    options: Omit<RequestOptions, "token"> = {},
  ): Promise<T> {
    const owner = current.current;
    if (!owner || status !== "authenticated")
      throw new ApiError("Please sign in to continue.", 401);
    try {
      const result = await apiRequest<T>(path, {
        ...options,
        token: owner.token,
      });
      // A response started by a previous session cannot populate a new user's page.
      if (current.current !== owner)
        throw new DOMException("Session changed", "AbortError");
      return result;
    } catch (error) {
      if (current.current !== owner)
        throw new DOMException("Session changed", "AbortError");
      if (error instanceof ApiError && error.status === 401)
        clear("Your session has expired. Please sign in again.");
      throw error;
    }
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        status,
        notice,
        signIn,
        signOut: () => clear(),
        retry: () => {
          if (current.current) void verify(current.current);
        },
        request,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
