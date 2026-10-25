import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AuthForm } from "./features/auth/AuthForm";
import { AuthProvider } from "./features/auth/AuthProvider";
import { useAuth } from "./features/auth/auth.context";
import { ProtectedRoute } from "./features/auth/ProtectedRoute";
import "./App.css";
import { DocumentsPage } from "./features/documents/DocumentsPage";
import { ChatPage } from "./features/chat/ChatPage";
import { OrganizationPage } from "./features/organization/OrganizationPage";
import { MembersPage } from "./features/organization/MembersPage";
import {
  InvitationsPage,
  AcceptInvitationPage,
} from "./features/organization/InvitationsPage";

function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { status, signIn, notice } = useAuth();
  const location = useLocation();
  const requested = new URLSearchParams(location.search).get("returnTo");
  // Only allow our invitation route as an auth return target; never redirect to an external URL.
  const returnTo = requested?.startsWith("/invitations/accept?")
    ? requested
    : "/dashboard";
  const invitationToken =
    returnTo === "/dashboard"
      ? undefined
      : (new URLSearchParams(returnTo.split("?")[1]).get("token") ?? undefined);
  // Invitation registration already consumes the token and signs into that organization.
  if (status !== "anonymous")
    return (
      <Navigate to={mode === "register" ? "/dashboard" : returnTo} replace />
    );
  return (
    <>
      {notice && (
        <p className="form-error" role="alert">
          {notice}
        </p>
      )}
      <AuthForm
        key={mode}
        mode={mode}
        onAuthenticated={signIn}
        invitationToken={mode === "register" ? invitationToken : undefined}
      />
    </>
  );
}

function Dashboard() {
  const { session } = useAuth();
  if (!session) return null;
  return (
    <section className="workspace" aria-labelledby="welcome-heading">
      <p className="eyebrow">YOUR WORKSPACE</p>
      <h1
        id="welcome-heading"
        tabIndex={-1}
        ref={(element) => element?.focus()}
      >
        Welcome, {session.user.name}
      </h1>
      <p>You are signed in to {session.organization.name}.</p>
      <dl className="account-details">
        <div>
          <dt>Email</dt>
          <dd>{session.user.email}</dd>
        </div>
        <div>
          <dt>Organization</dt>
          <dd>{session.organization.name}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{session.role}</dd>
        </div>
      </dl>
      <div className="workspace-note">
        <h2>Your knowledge workspace</h2>
        <p>
          Upload documents to prepare your organization’s knowledge for
          questions.
        </p>
        <Link className="text-button" to="/documents">
          Upload a document
        </Link>{" "}
        <Link className="text-button" to="/chat">
          Ask a question
        </Link>
      </div>
    </section>
  );
}

function AppRoutes() {
  const { status, signOut } = useAuth();
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" to="/">
          {" "}
          <span className="brand-mark" aria-hidden="true">
            N
          </span>{" "}
          NexaAI
        </Link>
        {status !== "anonymous" && (
          <nav aria-label="Workspace">
            {status === "authenticated" && (
              <>
                <Link className="text-button" to="/dashboard">
                  Dashboard
                </Link>{" "}
                <Link className="text-button" to="/documents">
                  Documents
                </Link>{" "}
                <Link className="text-button" to="/chat">
                  Chat
                </Link>{" "}
                <Link className="text-button" to="/organization">
                  Organization
                </Link>
              </>
            )}{" "}
            <button className="secondary-button" onClick={signOut}>
              Sign out
            </button>
          </nav>
        )}
      </header>
      <main>
        <Routes>
          <Route
            path="/"
            element={
              <Navigate
                to={status === "anonymous" ? "/login" : "/dashboard"}
                replace
              />
            }
          />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route
            path="/invitations/accept"
            element={<AcceptInvitationPage />}
          />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/organization" element={<OrganizationPage />} />
            <Route path="/organization/members" element={<MembersPage />} />
            <Route
              path="/organization/invitations"
              element={<InvitationsPage />}
            />
            {/* Chat shares the same verified-session guard as the other workspace pages. */}
            <Route path="/chat" element={<ChatPage />} />
          </Route>
          <Route
            path="*"
            element={
              <section className="workspace">
                <h1>Page not found</h1>
                <Link to="/">Return home</Link>
              </section>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
