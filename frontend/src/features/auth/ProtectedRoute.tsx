import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./auth.context";

export function ProtectedRoute() {
  const { status, retry, signOut } = useAuth();
  const location = useLocation();
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
  // Preserve account-level recovery while hiding every old organization's view.
  if (status === "restricted" && location.pathname !== "/organizations/switch")
    return (
      <section className="workspace">
        <h1>Organization access changed</h1>
        <p role="alert">
          Your membership is no longer available. Switch organization or sign in
          again.
        </p>
        <p>
          Use Switch organization above to choose a workspace you still belong
          to.
        </p>
        <button className="secondary-button" onClick={retry}>
          Try again
        </button>
      </section>
    );
  return <Outlet />;
}
