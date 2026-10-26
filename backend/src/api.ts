import express from "express";
import prisma from "./config/database";
import authRoutes, { authJsonError } from "./auth/auth.routes";
import protectedRoutes from "./auth/auth.protected.route";
import organizationRoutes from "./organization/organization.routes";
import documentRoutes from "./document/document.routes";
import ragRoutes from "./rag/rag.routes";
import agentRoutes, { agentJsonError } from "./agents/agent.routes";
import dashboardRoutes, { dashboardJsonError } from "./analytics/dashboard.routes";
import { installApiBoundary, apiError } from "./http/api.boundary";
import { installUsageAdmission, type AdmissionStore, type UsageBudgets } from "./http/usage.admission";

// The exact production middleware/routes can run on an ephemeral test port.
// Starting the server and warming Redis belong only to the app.ts entry point.
export function createApiApp(options: { origins?: string[]; admissionStore?: AdmissionStore; usageBudgets?: UsageBudgets } = {}) {
  const app = express();
  installApiBoundary(app, options.origins);
  installUsageAdmission(app, options.admissionStore, options.usageBudgets);
  app.use("/api/v1/auth", authRoutes, protectedRoutes, authJsonError);
  app.use("/api/v1/organizations", organizationRoutes);
  app.use("/api/v1/documents", documentRoutes);
  app.use("/api/v1/chat", ragRoutes);
  app.use("/api/v1/agents", agentRoutes, agentJsonError);
  app.use("/api/v1/analytics", dashboardRoutes, dashboardJsonError);
  app.get("/api/v1/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return res.json({ success: true, message: "NexaAI backend and database are running", timestamp: new Date().toISOString() });
    } catch { return res.status(503).json({ success: false, message: "Database connection failed" }); }
  });
  app.use((_req, res) => res.status(404).json({ success: false, code: "NOT_FOUND", message: "API endpoint not found." }));
  app.use(apiError);
  return app;
}
