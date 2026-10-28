import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import type { ReactNode } from "react";
import { AuthForm } from "./features/auth/AuthForm";
import { AuthProvider } from "./features/auth/AuthProvider";
import { useAuth } from "./features/auth/auth.context";
import { ProtectedRoute } from "./features/auth/ProtectedRoute";
import "./App.css";
import { DocumentsPage } from "./features/documents/DocumentsPage";
import { ChatPage } from "./features/chat/ChatPage";
import { AgentPage } from "./features/agents/AgentPage";
import { DashboardPage } from "./features/analytics/DashboardPage";
import { OperationsPage } from "./features/operations/OperationsPage";
import { OrganizationPage } from "./features/organization/OrganizationPage";
import { MembersPage } from "./features/organization/MembersPage";
import { SwitchOrganizationPage } from "./features/organization/SwitchOrganizationPage";
import {
  InvitationsPage,
  AcceptInvitationPage,
} from "./features/organization/InvitationsPage";

type NavigationIconName =
  | "dashboard"
  | "documents"
  | "chat"
  | "agent"
  | "organization"
  | "operations"
  | "switch";

function NavigationIcon({ name }: { name: NavigationIconName }) {
  const paths: Record<NavigationIconName, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    documents: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h5M10 12h5M10 16h5" /></>,
    chat: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 13h5" /></>,
    agent: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z" /><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8zM5 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></>,
    organization: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 20v-2.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V20M15 14h1.5a4 4 0 0 1 4 4v2" /></>,
    operations: <><path d="M4 12h3l2-5 4 10 2-5h5" /><circle cx="12" cy="12" r="9" /></>,
    switch: <><path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3" /></>,
  };
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const workspaceLinks: Array<{ to: string; label: string; icon: NavigationIconName }> = [
  { to: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { to: "/documents", label: "Documents", icon: "documents" },
  { to: "/chat", label: "Chat", icon: "chat" },
  { to: "/agent", label: "Agent", icon: "agent" },
  { to: "/organization", label: "Organization", icon: "organization" },
  { to: "/operations", label: "Operations", icon: "operations" },
  { to: "/organizations/switch", label: "Switch organization", icon: "switch" },
];

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

function AppRoutes() {
  const { status, signOut, session } = useAuth();
  const workspaceVisible = status !== "anonymous";
  return (
    <div className={`app-shell${workspaceVisible ? " app-shell--workspace" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <Link className="brand" to="/" aria-label="NexaAI home">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span className="brand-copy">
            <strong>NexaAI</strong>
            <small>Knowledge workspace</small>
          </span>
        </Link>
        {workspaceVisible && session && (
          <div className="workspace-identity">
            <span className="workspace-avatar" aria-hidden="true">
              {session.organization.name.trim().charAt(0).toUpperCase() || "N"}
            </span>
            <span>
              <small>Current workspace</small>
              <strong>{session.organization.name} workspace</strong>
            </span>
          </div>
        )}
        {workspaceVisible && (
          <nav aria-label="Workspace">
            {status === "restricted" && (
              <NavLink className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} to="/organizations/switch">
                <NavigationIcon name="switch" />
                <span>Switch organization</span>
              </NavLink>
            )}
            {status === "authenticated" && (
              workspaceLinks.map((item) => (
                <NavLink
                  key={item.to}
                  className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
                  to={item.to}
                >
                  <NavigationIcon name={item.icon} />
                  <span>{item.label}</span>
                </NavLink>
              ))
            )}
          </nav>
        )}
        {workspaceVisible && (
          <div className="sidebar-footer">
            {session && (
              <div className="signed-in-user">
                <span className="user-avatar" aria-hidden="true">{session.user.name.trim().charAt(0).toUpperCase() || "U"}</span>
                <span>
                  <strong>{session.user.name}</strong>
                  <small>{session.role} role</small>
                </span>
              </div>
            )}
            <button className="signout-button" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main className="app-main" id="main-content">
        {/* Recreate every page on an organization change: drafts, selected chats,
            upload results and pending request cleanup belong to the old workspace. */}
        <Routes
          key={`${session?.user.id ?? "anonymous"}:${session?.organization.id ?? "none"}`}
        >
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
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route
              path="/organizations/switch"
              element={<SwitchOrganizationPage />}
            />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/organization" element={<OrganizationPage />} />
            <Route path="/organization/members" element={<MembersPage />} />
            <Route
              path="/organization/invitations"
              element={<InvitationsPage />}
            />
            {/* Chat shares the same verified-session guard as the other workspace pages. */}
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/agent" element={<AgentPage />} />
            <Route path="/operations" element={<OperationsPage />} />
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
