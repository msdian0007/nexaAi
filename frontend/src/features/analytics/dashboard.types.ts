const DAY = 86400000;
export const documentStatuses = [
  "UPLOADED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;
export const requestOutcomes = [
  "STARTED",
  "SUCCEEDED",
  "FAILED",
  "UNCONFIRMED",
] as const;
export type DashboardDates = { from: string; through: string };
export type DashboardQuery = { from: string; to: string };
export type DashboardSummary = {
  definitionVersion: 1;
  asOf: string;
  range: { from: string; to: string; timezone: "UTC"; days: number };
  currentDocuments: {
    scope: "organization";
    total: number;
    byStatus: Record<(typeof documentStatuses)[number], number>;
  };
  personalActivity: {
    scope: "current_user";
    savedChatQuestions: number;
    agentRequests: {
      total: number;
      byOutcome: Record<(typeof requestOutcomes)[number], number>;
    };
  };
  daily: {
    date: string;
    organizationUploads: number;
    ownSavedChatQuestions: number;
    ownAgentRequests: number;
  }[];
};

function utcDate(value: string): number {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-") ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    throw new Error("Choose valid From and Through dates.");
  return time;
}

export function defaultDashboardDates(now = new Date()): DashboardDates {
  const through = now.toISOString().slice(0, 10);
  return {
    from: new Date(utcDate(through) - 6 * DAY).toISOString().slice(0, 10),
    through,
  };
}

export function dashboardQuery(
  dates: DashboardDates,
  now = new Date(),
): DashboardQuery {
  const from = utcDate(dates.from),
    through = utcDate(dates.through);
  // Users select an inclusive last day. Advance by a UTC day for the API's
  // exclusive 'to' boundary; local timezone and daylight saving cannot shift it.
  if (
    through < from ||
    (through - from) / DAY >= 90 ||
    through > utcDate(now.toISOString().slice(0, 10))
  )
    throw new Error("Choose 1 to 90 UTC days, ending no later than today.");
  return {
    from: dates.from,
    to: new Date(through + DAY).toISOString().slice(0, 10),
  };
}

export function parseDashboardSummary(
  value: unknown,
  expected: DashboardQuery,
): DashboardSummary {
  const invalid = () => {
    throw new Error("The dashboard response was invalid. Please try again.");
  };
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const count = (v: unknown): v is number =>
    Number.isSafeInteger(v) && Number(v) >= 0;
  const counters = (v: unknown, keys: readonly string[]) =>
    record(v) && keys.every((k) => count(v[k]));
  if (
    !record(value) ||
    value.definitionVersion !== 1 ||
    typeof value.asOf !== "string" ||
    !Number.isFinite(Date.parse(value.asOf)) ||
    !record(value.range) ||
    value.range.from !== expected.from ||
    value.range.to !== expected.to ||
    value.range.timezone !== "UTC"
  )
    return invalid();
  const days = (utcDate(expected.to) - utcDate(expected.from)) / DAY;
  if (
    days < 1 ||
    days > 90 ||
    value.range.days !== days ||
    !Array.isArray(value.daily) ||
    value.daily.length !== days
  )
    return invalid();
  const docs = value.currentDocuments,
    personal = value.personalActivity;
  if (
    !record(docs) ||
    docs.scope !== "organization" ||
    !count(docs.total) ||
    !counters(docs.byStatus, documentStatuses) ||
    !record(personal) ||
    personal.scope !== "current_user" ||
    !count(personal.savedChatQuestions) ||
    !record(personal.agentRequests) ||
    !count(personal.agentRequests.total) ||
    !counters(personal.agentRequests.byOutcome, requestOutcomes)
  )
    return invalid();
  for (const [i, row] of value.daily.entries()) {
    if (
      !record(row) ||
      row.date !==
        new Date(utcDate(expected.from) + i * DAY).toISOString().slice(0, 10) ||
      ![
        row.organizationUploads,
        row.ownSavedChatQuestions,
        row.ownAgentRequests,
      ].every(count)
    )
      return invalid();
  }
  // Validate totals as well as shape, so a malformed response cannot paint a
  // plausible chart that disagrees with the cards. Never coerce strings to counts.
  const summary = value as unknown as DashboardSummary;
  if (
    Object.values(summary.currentDocuments.byStatus).reduce(
      (a, b) => a + b,
      0,
    ) !== docs.total ||
    Object.values(summary.personalActivity.agentRequests.byOutcome).reduce(
      (a, b) => a + b,
      0,
    ) !== personal.agentRequests.total ||
    summary.daily.reduce((sum, d) => sum + d.ownSavedChatQuestions, 0) !==
      personal.savedChatQuestions ||
    summary.daily.reduce((sum, d) => sum + d.ownAgentRequests, 0) !==
      personal.agentRequests.total
  )
    return invalid();
  return summary;
}
