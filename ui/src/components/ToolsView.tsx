import { useEffect, useState } from 'react';
import { formatTokens } from '../../../src/tokens.js';
import type { SessionSummary, ToolsReport } from '../../../src/types.js';
import { formatDuration } from '../format';

interface Props {
  session: SessionSummary;
  onCompare(baseId: number, targetId: number): void;
}

/** Context cost and behaviour of one session's tools. */
export function ToolsView({ session, onCompare }: Props) {
  const [report, setReport] = useState<ToolsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refresh as the session records more messages.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${session.id}/tools`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as ToolsReport;
      })
      .then((data) => !cancelled && (setReport(data), setError(null)))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [session.id, session.message_count]);

  if (error) return <div className="list-empty detail-error">Couldn't load tools: {error}</div>;
  if (!report) return <div className="list-empty">Loading…</div>;

  const definitions = report.definitions;
  const sorted = definitions ? [...definitions.tools].sort((a, b) => b.tokens - a.tokens) : [];
  const widest = Math.max(1, ...sorted.map((tool) => tool.tokens));

  return (
    <div className="tools-view">
      <section className="card">
        <header className="card-head">
          <h2 className="card-title">Tool definitions</h2>
          {definitions && (
            <span className="card-figure">
              ≈{formatTokens(definitions.total)} <span className="muted">tokens · {sorted.length} tools</span>
            </span>
          )}
        </header>
        {definitions ? (
          <>
            <p className="card-note">
              Sent to the model with every request while this server is connected. Estimates; run{' '}
              <code>mcpspy tokens --exact</code> for counts from the API.
            </p>
            <ol className="cost-bars">
              {sorted.map((tool) => (
                <li key={tool.name} className="cost-bar">
                  <span className="cost-name mono">{tool.name}</span>
                  <span className="cost-track">
                    <span className="cost-fill" style={{ width: `${(tool.tokens / widest) * 100}%` }} />
                  </span>
                  <span className="cost-value mono">{formatTokens(tool.tokens)}</span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="card-note">No tools/list recorded in this session.</p>
        )}
      </section>

      {report.changes && (
        <section className="card">
          <header className="card-head">
            <h2 className="card-title">Changes since session #{report.previousSessionId}</h2>
            {report.changes.length > 0 && definitions?.requestId != null && report.previousListMessageId !== null && (
              <button className="text-button" onClick={() => onCompare(report.previousListMessageId!, definitions.requestId!)}>
                View diff
              </button>
            )}
          </header>
          {report.changes.length === 0 ? (
            <p className="card-note">The tool list is identical.</p>
          ) : (
            <ul className="change-list">
              {report.changes.map((change) => (
                <li key={change.name} className={`change change-${change.change}`}>
                  <span className="change-type">{change.change === 'added' ? '+' : change.change === 'removed' ? '−' : '~'}</span>
                  <span className="mono">{change.name}</span>
                  {change.fields.length > 0 && <span className="muted">{change.fields.join(', ')}</span>}
                  {change.tokenDelta !== 0 && (
                    <span className="change-delta mono">
                      {change.tokenDelta > 0 ? '+' : '−'}
                      {formatTokens(Math.abs(change.tokenDelta))} tok
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card">
        <header className="card-head">
          <h2 className="card-title">Tool calls</h2>
        </header>
        {report.calls.length === 0 ? (
          <p className="card-note">No tool calls yet.</p>
        ) : (
          <table className="stats">
            <thead>
              <tr>
                <th>Tool</th>
                <th className="num">Calls</th>
                <th className="num">Errors</th>
                <th className="num">Avg</th>
                <th className="num">Max</th>
                <th className="num">Result tokens</th>
                <th className="num">Largest</th>
              </tr>
            </thead>
            <tbody>
              {report.calls.map((stats) => (
                <tr key={stats.name}>
                  <td className="mono">{stats.name}</td>
                  <td className="num mono">{stats.calls}</td>
                  <td className={`num mono ${stats.errors ? 'is-bad' : ''}`}>{stats.errors}</td>
                  <td className="num mono">{stats.avgLatency !== null ? formatDuration(stats.avgLatency) : '–'}</td>
                  <td className="num mono">{stats.maxLatency !== null ? formatDuration(stats.maxLatency) : '–'}</td>
                  <td className="num mono">≈{formatTokens(stats.totalTokens)}</td>
                  <td className="num mono">≈{formatTokens(stats.maxTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
