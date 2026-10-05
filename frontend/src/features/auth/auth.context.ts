import { createContext, useContext } from "react";
import type { AuthSession } from "./auth.api";
import type { RequestOptions } from "../../services/api";

export interface AuthState {
  session: AuthSession | null;
  status: "anonymous" | "checking" | "authenticated" | "unavailable";
  notice: string;
  signIn: (session: AuthSession) => void;
  signOut: () => void;
  retry: () => void;
  request: <T>(
    path: string,
    options?: Omit<RequestOptions, "token">,
  ) => Promise<T>;
}
export const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth requires AuthProvider");
  return value;
}
