import prisma from "../config/database";
import {
  readAgentContext,
  requireAgentMembership,
} from "../agents/agent.access";
import { dashboardDates, parseDashboardRange } from "./dashboard.contracts";
import type { DashboardSummary } from "./dashboard.contracts";

// PostgreSQL COUNT returns bigint. Refuse an inaccurate JSON number instead of
// silently rounding a count or describing a failed read as zero activity.
function count(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid aggregate count");
  return result;
}

export async function getDashboardSummary(
  authenticatedContext: unknown,
  query: unknown,
): Promise<DashboardSummary> {
  const context = readAgentContext(authenticatedContext);
  const range = parseDashboardRange(query);
  return prisma.$transaction(
    async (tx) => {
      // Membership and every metric see the same committed database snapshot.
      // Fixed control SQL supplies options that Prisma does not expose directly.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      await requireAgentMembership(context, tx);
      const asOf = new Date().toISOString();
      const documents = await tx.document.groupBy({
        by: ["status"],
        where: {
          organizationId: context.organizationId,
          deletionRequestedAt: null,
        },
        _count: { _all: true },
      });
      const outcomes = await tx.agentExecution.groupBy({
        by: ["outcome"],
        where: {
          ...context,
          operation: "REQUEST",
          startedAt: { gte: range.fromDate, lt: range.toDate },
        },
        _count: { _all: true },
      });
      // Prisma groupBy cannot group timestamps into calendar days. This fixed,
      // parameterized SQL does that work inside PostgreSQL; no private rows leave
      // the database. Stored timestamp(3) values are UTC without a timezone.
      // Casting ISO boundaries to timestamp avoids session-timezone conversions.
      const rows = await tx.$queryRaw<
        Array<{
          date: string;
          uploads: bigint;
          questions: bigint;
          requests: bigint;
        }>
      >`
      SELECT day::text AS date, SUM(uploads)::bigint AS uploads,
        SUM(questions)::bigint AS questions, SUM(requests)::bigint AS requests
      FROM (
        SELECT "createdAt"::date AS day, COUNT(*) AS uploads,
          0::bigint AS questions, 0::bigint AS requests
        FROM "Document"
        WHERE "organizationId" = ${context.organizationId} AND "deletionRequestedAt" IS NULL
          AND "createdAt" >= ${range.from + "T00:00:00"}::timestamp
          AND "createdAt" < ${range.to + "T00:00:00"}::timestamp
        GROUP BY day
        UNION ALL
        SELECT m."createdAt"::date AS day, 0::bigint, COUNT(*), 0::bigint
        FROM "Message" m JOIN "Conversation" c
          ON c.id = m."conversationId" AND c."organizationId" = m."organizationId"
        WHERE m."organizationId" = ${context.organizationId} AND c."userId" = ${context.userId}
          AND m.role = 'USER'
          AND m."createdAt" >= ${range.from + "T00:00:00"}::timestamp
          AND m."createdAt" < ${range.to + "T00:00:00"}::timestamp
        GROUP BY day
        UNION ALL
        SELECT "startedAt"::date AS day, 0::bigint, 0::bigint, COUNT(*)
        FROM "AgentExecution"
        WHERE "organizationId" = ${context.organizationId} AND "userId" = ${context.userId}
          AND operation = 'REQUEST'
          AND "startedAt" >= ${range.from + "T00:00:00"}::timestamp
          AND "startedAt" < ${range.to + "T00:00:00"}::timestamp
        GROUP BY day
      ) activity GROUP BY day ORDER BY day
    `;
      const byStatus: DashboardSummary["currentDocuments"]["byStatus"] = {
        UPLOADED: 0,
        PROCESSING: 0,
        COMPLETED: 0,
        FAILED: 0,
      };
      const byOutcome: DashboardSummary["personalActivity"]["agentRequests"]["byOutcome"] =
        {
          STARTED: 0,
          SUCCEEDED: 0,
          FAILED: 0,
          UNCONFIRMED: 0,
        };
      for (const group of documents) byStatus[group.status] = group._count._all;
      for (const group of outcomes)
        byOutcome[group.outcome] = group._count._all;
      const days = new Map(rows.map((row) => [row.date, row]));
      // Expand only the selected 1–90 days, including days with no saved records.
      const daily = dashboardDates(range).map((date) => {
        const row = days.get(date);
        return {
          date,
          organizationUploads: count(row?.uploads ?? 0n),
          ownSavedChatQuestions: count(row?.questions ?? 0n),
          ownAgentRequests: count(row?.requests ?? 0n),
        };
      });
      return {
        definitionVersion: 1,
        asOf,
        range: {
          from: range.from,
          to: range.to,
          timezone: "UTC",
          days: range.days,
        },
        currentDocuments: {
          scope: "organization",
          total: Object.values(byStatus).reduce((a, b) => a + b, 0),
          byStatus,
        },
        personalActivity: {
          scope: "current_user",
          savedChatQuestions: daily.reduce(
            (sum, day) => sum + day.ownSavedChatQuestions,
            0,
          ),
          agentRequests: {
            total: Object.values(byOutcome).reduce((a, b) => a + b, 0),
            byOutcome,
          },
        },
        daily,
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 5000, maxWait: 2000 },
  );
}
