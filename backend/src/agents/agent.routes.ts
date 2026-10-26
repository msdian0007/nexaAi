import { Router } from "express";
import type { Response, ErrorRequestHandler } from "express";
import { authenticate } from "../auth/auth.middleware";
import type { AuthenticatedRequest } from "../auth/auth.middleware";
import prisma from "../config/database";
import {
  AgentIdentityError,
  AgentMembershipError,
  readAgentContext,
  requireAgentMembership,
} from "./agent.access";
import { AgentContractError } from "./agent.contracts";
import { AgentRequestError, AgentRoutingError } from "./agent.routing";
import { runAgentRequest } from "./agent.service";
import {
  AgentActionError,
  confirmDocumentRetry,
  cancelRetryProposal,
  readRetryProposal,
} from "./retry.tool";
import { DocumentDeletionError } from "../document/document.deletion";
import { getDocumentQueue } from "../document/document.queue.runtime";
import { getDocumentStatus } from "../document/document.service";
import { GeminiProviderError } from "../rag/gemini.provider";
import { RagResponseValidationError } from "../rag/rag.response";

const router = Router();
// express.json runs before authentication/routes. Keep its parse/size failures
// in the agent's safe JSON format rather than Express's default HTML error page.
export const agentJsonError: ErrorRequestHandler = (error, _req, res, next) => {
  if (
    error?.type === "entity.parse.failed" ||
    error?.type === "entity.too.large"
  ) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(error.type === "entity.too.large" ? 413 : 400).json({
      success: false,
      code: "INVALID_AGENT_REQUEST",
      message: "Provide a valid request within the size limit.",
    });
  }
  return next(error);
};
// Sensitive responses must not be cached, including authentication failures.
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const queueFor = (req: AuthenticatedRequest) =>
  req.app.locals.getDocumentQueue ?? getDocumentQueue;
function input(req: AuthenticatedRequest, keys: string[]) {
  if (
    Object.keys(req.query).length ||
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).length !== keys.length ||
    !keys.every((k) => Object.prototype.hasOwnProperty.call(req.body, k))
  )
    throw new AgentRequestError();
}
function empty(req: AuthenticatedRequest) {
  if (
    Object.keys(req.query).length ||
    (req.body !== undefined &&
      (!req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length))
  )
    throw new AgentRequestError();
}
function proposalInput(req: AuthenticatedRequest) {
  const id = req.params.proposalId;
  if (typeof id !== "string" || !uuid.test(id)) throw new AgentRequestError();
  return { proposalId: id };
}
function safeFailure(error: unknown) {
  if (error instanceof AgentIdentityError)
    return { status: 401, code: error.code, message: "Please sign in again." };
  if (error instanceof AgentMembershipError)
    return {
      status: 403,
      code: error.code,
      message: "Current membership is required.",
    };
  if (error instanceof AgentRequestError || error instanceof AgentContractError)
    return {
      status: 400,
      code: error.code,
      message: "Check the request fields and try again.",
    };
  if (error instanceof AgentActionError)
    return { status: error.status, code: error.code, message: error.message };
  if (error instanceof DocumentDeletionError)
    return {
      status: error.status,
      code: "DOCUMENT_CHANGED",
      message: "Access or document state changed. Refresh document status.",
    };
  if (
    error instanceof AgentRoutingError ||
    error instanceof RagResponseValidationError
  )
    return {
      status: 502,
      code: "INVALID_AGENT_RESPONSE",
      message: "The generated response failed validation.",
    };
  if (error instanceof GeminiProviderError)
    return {
      status: error.code === "TIMEOUT" ? 504 : 503,
      code: "GENERATION_UNAVAILABLE",
      message: "Generation is unavailable. Please try again later.",
    };
  return {
    status: 503,
    code: "AGENT_UNAVAILABLE",
    message:
      "The agent operation could not be confirmed. Check saved status before trying again.",
  };
}
function failure(res: Response, error: unknown, executionId?: string) {
  const data = safeFailure(error);
  return res.status(data.status).json({
    success: false,
    code: data.code,
    message: data.message,
    ...(executionId ? { executionId } : {}),
  });
}

// A durable STARTED record is required before tool/model work. Finalization may
// fail after a queue write, so clients must never auto-repeat a failed confirmation.
async function tracked(
  req: AuthenticatedRequest,
  res: Response,
  operation: "REQUEST" | "CONFIRM" | "CANCEL",
) {
  let executionId: string | undefined;
  let completed = false;
  try {
    const context = readAgentContext(req.user);
    if (operation === "REQUEST") input(req, ["message"]);
    else {
      empty(req);
      proposalInput(req);
    }
    await requireAgentMembership(context);
    const record = await prisma.agentExecution.create({
      data: {
        ...context,
        operation,
        ...(operation !== "REQUEST"
          ? {
              tool: "retry_document",
              proposalId: req.params.proposalId as string,
            }
          : {}),
      },
    });
    executionId = record.id;
    const started = Date.now();
    try {
      const data =
        operation === "REQUEST"
          ? await runAgentRequest(context, req.body.message, {
              queueProvider: queueFor(req),
              onToolSelected: async (tool) => {
                await prisma.agentExecution.update({
                  where: { id: record.id },
                  data: { tool },
                });
              },
            })
          : operation === "CONFIRM"
            ? await confirmDocumentRetry(
                context,
                proposalInput(req),
                queueFor(req),
              )
            : await cancelRetryProposal(context, proposalInput(req));
      completed = true;
      await prisma.agentExecution.update({
        where: { id: record.id },
        data: {
          outcome: "SUCCEEDED",
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          ...(operation === "REQUEST" &&
          "kind" in data &&
          data.kind === "action_proposal"
            ? { proposalId: data.proposal.id }
            : {}),
        },
      });
      return res
        .status(operation === "CONFIRM" ? 202 : 200)
        .json({ success: true, data: { executionId, result: data } });
    } catch (error) {
      const code = completed ? "RECORD_UNCONFIRMED" : safeFailure(error).code;
      await prisma.agentExecution
        .updateMany({
          where: { id: record.id },
          data: {
            outcome:
              completed || code === "SUBMISSION_UNCONFIRMED"
                ? "UNCONFIRMED"
                : "FAILED",
            errorCode: code,
            finishedAt: new Date(),
            durationMs: Date.now() - started,
          },
        })
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return failure(res, error, executionId);
  }
}

router.post("/requests", (req, res) => tracked(req, res, "REQUEST"));
router.post("/proposals/:proposalId/confirm", (req, res) =>
  tracked(req, res, "CONFIRM"),
);
router.post("/proposals/:proposalId/cancel", (req, res) =>
  tracked(req, res, "CANCEL"),
);
router.get("/proposals/:proposalId", async (req: AuthenticatedRequest, res) => {
  try {
    empty(req);
    return res.json({
      success: true,
      data: await readRetryProposal(
        readAgentContext(req.user),
        proposalInput(req),
      ),
    });
  } catch (error) {
    return failure(res, error);
  }
});
router.get(
  "/proposals/:proposalId/document-status",
  async (req: AuthenticatedRequest, res) => {
    try {
      empty(req);
      const context = readAgentContext(req.user);
      const proposal = await readRetryProposal(context, proposalInput(req));
      const document = await getDocumentStatus(
        proposal.documentId,
        context.organizationId,
        queueFor(req),
      );
      if (!document)
        throw new AgentActionError(
          "DOCUMENT_UNAVAILABLE",
          404,
          "Document is unavailable.",
        );
      return res.json({ success: true, data: document });
    } catch (error) {
      return failure(res, error);
    }
  },
);
router.get("/executions", async (req: AuthenticatedRequest, res) => {
  try {
    empty(req);
    const context = readAgentContext(req.user);
    const records = await prisma.$transaction(
      async (tx) => {
        await requireAgentMembership(context, tx);
        return tx.agentExecution.findMany({
          where: context,
          take: 20,
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            operation: true,
            tool: true,
            proposalId: true,
            outcome: true,
            errorCode: true,
            startedAt: true,
            finishedAt: true,
            durationMs: true,
          },
        });
      },
      { isolationLevel: "RepeatableRead" },
    );
    return res.json({ success: true, data: { executions: records } });
  } catch (error) {
    return failure(res, error);
  }
});
export default router;
