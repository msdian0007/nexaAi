import type { DocumentCountsResult } from "../agents/agent.contracts";

// Contract only in 13.1. The summary API and its database permissions arrive in
// 13.2; this module neither queries data nor grants access to an organization.
export const DASHBOARD_MAX_DAYS = 90;
export const DASHBOARD_DEFAULT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export class DashboardInputError extends Error {
  readonly code = "INVALID_DASHBOARD_RANGE";
  constructor() {
    super(
      "Use paired valid UTC dates from and to, spanning 1 to 90 days and ending no later than tomorrow.",
    );
  }
}

export type DashboardRange = {
  from: string;
  to: string;
  fromDate: Date;
  toDate: Date;
  days: number;
};

function utcDate(value: unknown): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-")
  )
    throw new DashboardInputError();
  const date = new Date(`${value}T00:00:00.000Z`);
  // JS can normalize Feb 30 into March: reject that instead of silently moving
  // the reporting boundary. No local timezone or daylight-saving arithmetic.
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new DashboardInputError();
  return date;
}

export function parseDashboardRange(
  query: unknown,
  now = new Date(),
): DashboardRange {
  if (
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    !Number.isFinite(now.getTime())
  )
    throw new DashboardInputError();
  const prototype = Object.getPrototypeOf(query);
  if (prototype !== Object.prototype && prototype !== null)
    throw new DashboardInputError();
  const input = query as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.some((key) => key !== "from" && key !== "to") ||
    (keys.length !== 0 && keys.length !== 2)
  )
    throw new DashboardInputError();
  const tomorrow = utcDate(now.toISOString().slice(0, 10)).getTime() + DAY_MS;
  const defaultFrom = new Date(tomorrow - DASHBOARD_DEFAULT_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const fromDate = utcDate(keys.length === 0 ? defaultFrom : input.from);
  const toDate = utcDate(
    keys.length === 0
      ? new Date(tomorrow).toISOString().slice(0, 10)
      : input.to,
  );
  const days = (toDate.getTime() - fromDate.getTime()) / DAY_MS;
  // 'to' is exclusive, allowing tomorrow's midnight to include today's partial
  // activity. Future-only ranges, inverted dates and unbounded scans are rejected.
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > DASHBOARD_MAX_DAYS ||
    toDate.getTime() > tomorrow
  )
    throw new DashboardInputError();
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    fromDate,
    toDate,
    days,
  };
}

export function dashboardDates(range: DashboardRange): string[] {
  // Derive buckets from validated boundaries, not a caller-supplied array length.
  // Calendar expansion assumes the HTTP range was already checked against the
  // real server time. Ignore mutable/precomputed Date and day-count properties.
  const checked = parseDashboardRange(
    { from: range.from, to: range.to },
    utcDate(range.to),
  );
  return Array.from({ length: checked.days }, (_, day) =>
    new Date(checked.fromDate.getTime() + day * DAY_MS)
      .toISOString()
      .slice(0, 10),
  );
}

export type DashboardSummary = {
  definitionVersion: 1;
  asOf: string;
  range: { from: string; to: string; timezone: "UTC"; days: number };
  // Current snapshot; deliberately unaffected by the activity date filter.
  currentDocuments: {
    scope: "organization";
    total: number;
    byStatus: DocumentCountsResult["byStatus"];
  };
  personalActivity: {
    scope: "current_user";
    savedChatQuestions: number;
    // REQUEST operations only. Confirmation/cancellation are separate operations,
    // and SUCCEEDED does not imply a factual answer or completed document retry.
    agentRequests: {
      total: number;
      byOutcome: {
        STARTED: number;
        SUCCEEDED: number;
        FAILED: number;
        UNCONFIRMED: number;
      };
    };
  };
  // Each UTC day is present, including zero activity. Names make mixed scope
  // explicit: organization uploads versus the current user's retained activity.
  daily: Array<{
    date: string;
    organizationUploads: number;
    ownSavedChatQuestions: number;
    ownAgentRequests: number;
  }>;
};
