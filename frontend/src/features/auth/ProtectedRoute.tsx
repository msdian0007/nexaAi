import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./auth.context";

export function ProtectedRoute() {
  const { status, retry, signOut } = useAuth();
  if (status === "anonymous") return <Navigate to="/login" replace />;
  if (status === "checking")
    return (
      <section className="workspace" role="status">
        Checking your session...
      </section>
    );
  if (status === "unavailable")
    return (
      <section className="workspace">
        <h1>Unable to verify your session</h1>
        <p role="alert">
          We could not reach the authentication service. Try again when the
          connection is available.
        </p>
        <button className="secondary-button" onClick={retry}>
          Try again
        </button>{" "}
        <button className="text-button" onClick={signOut}>
          Return to sign in
        </button>
      </section>
    );
  return <Outlet />;
}
