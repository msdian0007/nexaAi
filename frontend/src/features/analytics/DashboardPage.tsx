import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";
import {
  dashboardQuery,
  defaultDashboardDates,
  documentStatuses,
  parseDashboardSummary,
  requestOutcomes,
} from "./dashboard.types";
import type { DashboardSummary } from "./dashboard.types";

const series = [
  {
    key: "organizationUploads",
    label: "Organization uploads",
    color: "#126b63",
    dash: undefined,
  },
  {
    key: "ownSavedChatQuestions",
    label: "My saved questions",
    color: "#7843ad",
    dash: "8 4",
  },
  {
    key: "ownAgentRequests",
    label: "My agent requests",
    color: "#a54b13",
    dash: "2 4",
  },
] as const;
const labels: Record<string, string> = {
  UPLOADED: "Uploaded",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
  STARTED: "Started or interrupted",
  SUCCEEDED: "Succeeded",
  UNCONFIRMED: "Unconfirmed",
};

function ActivityChart({ daily }: { daily: DashboardSummary["daily"] }) {
  const max = Math.max(1, ...daily.flatMap((d) => series.map((s) => d[s.key])));
  const x = (i: number) =>
    daily.length === 1 ? 380 : 60 + (i * 640) / (daily.length - 1);
  const y = (v: number) => 200 - (v / max) * 160;
  return (
    <>
      <ul className="dashboard-legend" aria-label="Chart legend">
        {series.map((s) => (
          <li key={s.key}>
            <span style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      {/* The chart gives a quick pattern; the disclosure below exposes every exact
        value to keyboard and screen-reader users without relying on color. */}
      <svg
        className="activity-chart"
        viewBox="0 0 760 250"
        role="img"
        aria-labelledby="activity-chart-title activity-chart-description"
      >
        <title id="activity-chart-title">Daily retained activity in UTC</title>
        <desc id="activity-chart-description">
          Organization uploads, your saved questions and your agent requests.
          Exact values are in View daily values below. Today may be incomplete.
        </desc>
        {[0, max].map((v) => (
          <g key={v}>
            <line x1="60" x2="700" y1={y(v)} y2={y(v)} stroke="#dce5e7" />
            <text x="50" y={y(v) + 5} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            <polyline
              points={daily.map((d, i) => `${x(i)},${y(d[s.key])}`).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth="3"
              strokeDasharray={s.dash}
            />
            {daily.length === 1 && (
              <circle cx={x(0)} cy={y(daily[0][s.key])} r="5" fill={s.color} />
            )}
          </g>
        ))}
        <text x="60" y="232">
          {daily[0].date}
        </text>
        {daily.length > 1 && (
          <text x="700" y="232" textAnchor="end">
            {daily[daily.length - 1].date}
          </text>
        )}
      </svg>
      <details className="dashboard-values">
        <summary>View daily values</summary>
        <div
          className="dashboard-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Daily activity table"
        >
          <table>
            <caption>Retained activity by UTC date</caption>
            <thead>
              <tr>
                <th scope="col">Date (UTC)</th>
                {series.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.date}>
                  <th scope="row">{d.date}</th>
                  {series.map((s) => (
                    <td key={s.key}>{d[s.key].toLocaleString()}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

export function DashboardPage() {
  const { session, request } = useAuth();
  const [dates, setDates] = useState(defaultDashboardDates);
  const [applied, setApplied] = useState(() =>
    dashboardQuery(defaultDashboardDates()),
  );
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dateError, setDateError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Abort on navigation/range/workspace changes; a late response cannot restore
    // counts from the previous selection. The app also keys pages by workspace.
    request<unknown>("/analytics/summary", {
      query: applied,
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted)
          setData(parseDashboardSummary(value, applied));
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError && cause.status === 403
            ? "Your membership is no longer available. Switch organization or sign in again."
            : cause instanceof ApiError
              ? cause.message
              : "The dashboard response was invalid. Please try again.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request, applied, revision]);

  function load(event?: FormEvent) {
    event?.preventDefault();
    try {
      const query = dashboardQuery(dates);
      setDateError("");
      setError("");
      setData(null);
      setLoading(true);
      setApplied(query);
      setRevision((v) => v + 1);
    } catch (cause) {
      setDateError((cause as Error).message);
    }
  }
  if (!session) return null;
  return (
    <section
      className="workspace dashboard-page"
      aria-labelledby="welcome-heading"
    >
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1 id="welcome-heading" tabIndex={-1} ref={heading}>
            Welcome, {session.user.name}
          </h1>
          <p>You are signed in to {session.organization.name}.</p>
        </div>
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
      </header>
      <h2>Workspace summary</h2>
      <form
        className="dashboard-filters"
        onSubmit={load}
        aria-label="Activity date range"
      >
        <div>
          <label htmlFor="dashboard-from">From (UTC)</label>
          <input
            id="dashboard-from"
            type="date"
            required
            value={dates.from}
            max={defaultDashboardDates().through}
            onChange={(e) => setDates({ ...dates, from: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="dashboard-through">Through (UTC, included)</label>
          <input
            id="dashboard-through"
            type="date"
            required
            value={dates.through}
            max={defaultDashboardDates().through}
            onChange={(e) => setDates({ ...dates, through: e.target.value })}
          />
        </div>
        <button className="secondary-button" disabled={loading} type="submit">
          Apply dates
        </button>
        <button
          className="text-button"
          disabled={loading}
          type="button"
          onClick={() => {
            const defaults = defaultDashboardDates();
            setDates(defaults);
            setDateError("");
            setError("");
            setData(null);
            setLoading(true);
            setApplied(dashboardQuery(defaults));
            setRevision((v) => v + 1);
          }}
        >
          Last 7 days
        </button>
      </form>
      <p className="dashboard-hint">
        Choose up to 90 UTC days. Dates filter activity; document totals show
        current records. Today may be incomplete.
      </p>
      {dateError && (
        <p className="form-error" role="alert">
          {dateError}
        </p>
      )}
      {loading && <p role="status">Loading workspace summary…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="secondary-button"
            onClick={() => {
              setError("");
              setData(null);
              setLoading(true);
              setRevision((v) => v + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {data && (
        <>
          <p className="dashboard-hint">
            Showing activity from <strong>{data.range.from}</strong> through{" "}
            <strong>{data.daily[data.daily.length - 1].date}</strong> (UTC).
            Read at {new Date(data.asOf).toLocaleString()}.
          </p>
          {/* On wide screens the cards and chart share a row. This compact
              overview keeps the full dashboard useful at reduced browser zoom. */}
          <div className="dashboard-insights">
            <div className="dashboard-cards">
              <section
                className="dashboard-card"
                aria-labelledby="documents-card"
              >
              <h3 id="documents-card">Current documents</h3>
              <p>Shared · organization</p>
              <strong className="dashboard-number">
                {data.currentDocuments.total.toLocaleString()}
              </strong>
              <dl>
                {documentStatuses.map((s) => (
                  <div key={s}>
                    <dt>{labels[s]}</dt>
                    <dd>
                      {data.currentDocuments.byStatus[s].toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
              <small>
                Excludes documents pending deletion. Saved status, not live
                queue status.
              </small>
              </section>
              <section
                className="dashboard-card"
                aria-labelledby="questions-card"
              >
              <h3 id="questions-card">My saved questions</h3>
              <p>Private · selected dates</p>
              <strong className="dashboard-number">
                {data.personalActivity.savedChatQuestions.toLocaleString()}
              </strong>
              <small>
                Your retained chat questions. Assistant messages and agent
                requests are excluded.
              </small>
              </section>
              <section className="dashboard-card" aria-labelledby="requests-card">
              <h3 id="requests-card">My agent requests</h3>
              <p>Private · selected dates</p>
              <strong className="dashboard-number">
                {data.personalActivity.agentRequests.total.toLocaleString()}
              </strong>
              <dl>
                {requestOutcomes.map((s) => (
                  <div key={s}>
                    <dt>{labels[s]}</dt>
                    <dd>
                      {data.personalActivity.agentRequests.byOutcome[
                        s
                      ].toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
              <small>
                Excludes confirmations and cancellations. Succeeded does not
                mean a correct answer or completed document retry.
              </small>
              </section>
            </div>
            <section
              className="dashboard-activity"
              aria-labelledby="activity-heading"
            >
            <h2 id="activity-heading">Daily activity</h2>
            <p>
              Uploads are shared across the organization. Questions and agent
              requests are yours only.
            </p>
            {data.daily.every(
              (d) =>
                d.organizationUploads +
                  d.ownSavedChatQuestions +
                  d.ownAgentRequests ===
                0,
            ) && <p>No retained activity in this date range.</p>}
            <ActivityChart daily={data.daily} />
            <p className="dashboard-hint">
              Counts describe retained records. Deleting documents or
              conversations can lower earlier counts.
            </p>
            </section>
          </div>
          <button
            className="secondary-button"
            onClick={() => {
              setData(null);
              setError("");
              setLoading(true);
              setRevision((v) => v + 1);
            }}
          >
            Refresh summary
          </button>
        </>
      )}
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
