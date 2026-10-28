import { useEffect, useMemo, useState } from 'react';
import { DetailPane } from './components/DetailPane';
import { ExchangeList } from './components/ExchangeList';
import { SessionList } from './components/SessionList';
import type { ReplayOutcome } from './components/ReplayPanel';
import { ToolsView } from './components/ToolsView';
import { buildExchanges, filterExchanges, type ExchangeFilter } from './exchanges';
import { useLiveData } from './live';

export function App() {
  const { messages, sessions, connection } = useLiveData();
  const [filter, setFilter] = useState<ExchangeFilter>({
    sessionId: null,
    search: '',
    showNotifications: true,
    showLogs: true,
    errorsOnly: false,
    issuesOnly: false,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [compareBase, setCompareBase] = useState<number | null>(null);
  const [view, setView] = useState<'traffic' | 'tools'>('traffic');
  const [notice, setNotice] = useState<string | null>(null);

  const exchanges = useMemo(() => buildExchanges(messages), [messages]);
  const visible = useMemo(() => filterExchanges(exchanges, filter), [exchanges, filter]);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const selectedExchange = exchanges.find((exchange) => exchange.id === selected) ?? null;
  const errorCount = useMemo(() => visible.filter((exchange) => exchange.status === 'error').length, [visible]);
  const issueCount = useMemo(() => visible.filter((exchange) => exchange.issues.length > 0).length, [visible]);

  // The Tools tab describes one session: the selected one, else the newest.
  const toolsSession = filter.sessionId !== null ? sessionsById.get(filter.sessionId) : sessions[0];

  const describe = (id: number) => {
    const base = exchanges.find((exchange) => exchange.id === id || exchange.response?.id === id)?.primary;
    if (!base) return `message ${id}`;
    const session = sessionsById.get(base.session_id)?.name;
    return [base.method, base.subject, session && `(${session})`].filter(Boolean).join(' ');
  };

  const compare = (baseId: number, targetId: number) => {
    setCompareBase(baseId);
    setSelected(targetId);
  };

  // After a replay, show the new call diffed against the original.
  const onReplayed = (outcome: ReplayOutcome) => {
    const run = outcome.runs.at(-1);
    setView('traffic');
    // Follow the replay into its own session when one session is in view.
    if (filter.sessionId !== null) update({ sessionId: outcome.sessionId });
    if (run?.requestId != null) compare(outcome.original.requestId, run.requestId);
    const runs = outcome.runs.length > 1 ? `${outcome.runs.length} runs` : '1 run';
    setNotice(
      `Replayed in session #${outcome.sessionId} (${runs}).` +
        (outcome.missingEnv.length > 0
          ? ` The original server had ${outcome.missingEnv.join(', ')} set; start mcpspy ui with them to replay faithfully.`
          : ''),
    );
  };

  const update = (patch: Partial<ExchangeFilter>) => setFilter((previous) => ({ ...previous, ...patch }));

  // Arrow keys move through the list; Escape closes the detail pane.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') {
        if (compareBase !== null) setCompareBase(null);
        else setSelected(null);
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const index = visible.findIndex((exchange) => exchange.id === selected);
      const next = event.key === 'ArrowDown' ? index + 1 : index === -1 ? visible.length - 1 : index - 1;
      const target = visible[Math.max(0, Math.min(visible.length - 1, next))];
      if (target) setSelected(target.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected, compareBase]);

  return (
    <div className={`app ${selectedExchange ? 'has-detail' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          mcpspy
        </div>
        <input
          className="search"
          type="search"
          placeholder="Filter by method, tool, id or log text"
          value={filter.search}
          onChange={(event) => update({ search: event.target.value })}
        />
        <div className="toggles">
          <Toggle label="Notifications" checked={filter.showNotifications} onChange={(value) => update({ showNotifications: value })} />
          <Toggle label="stderr" checked={filter.showLogs} onChange={(value) => update({ showLogs: value })} />
          <Toggle label={`Errors only${errorCount ? ` (${errorCount})` : ''}`} checked={filter.errorsOnly} onChange={(value) => update({ errorsOnly: value })} />
          <Toggle label={`Schema issues${issueCount ? ` (${issueCount})` : ''}`} checked={filter.issuesOnly} onChange={(value) => update({ issuesOnly: value })} />
        </div>
        <span className={`connection connection-${connection}`}>
          <span className="dot" aria-hidden />
          {connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
        </span>
      </header>

      <SessionList sessions={sessions} selected={filter.sessionId} onSelect={(sessionId) => update({ sessionId })} />

      <main className="main">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === 'traffic'} className={view === 'traffic' ? 'is-on' : ''} onClick={() => setView('traffic')}>
            Traffic
          </button>
          <button role="tab" aria-selected={view === 'tools'} className={view === 'tools' ? 'is-on' : ''} onClick={() => setView('tools')}>
            Tools{toolsSession ? <span className="tab-note"> · {toolsSession.name ?? `#${toolsSession.id}`}</span> : null}
          </button>
        </div>
        {(notice || compareBase !== null) && (
          <div className="status-row">
            {notice && (
              <span className="notice">
                {notice}
                <button className="text-button" onClick={() => setNotice(null)} aria-label="Dismiss">
                  ×
                </button>
              </span>
            )}
            {compareBase !== null && (
              <span className="compare-hint">
                Comparing with {describe(compareBase)}. Select another row.
                <button className="text-button" onClick={() => setCompareBase(null)}>
                  Clear
                </button>
              </span>
            )}
          </div>
        )}
        {view === 'traffic' ? (
          <ExchangeList
            exchanges={visible}
            sessions={sessionsById}
            showSession={filter.sessionId === null}
            selected={selected}
            compareBase={compareBase}
            onSelect={setSelected}
          />
        ) : toolsSession ? (
          <ToolsView session={toolsSession} onCompare={compare} />
        ) : (
          <div className="list-empty">No sessions yet.</div>
        )}
      </main>

      {selectedExchange && (
        <DetailPane
          exchange={selectedExchange}
          sessionName={sessionsById.get(selectedExchange.primary.session_id)?.name ?? `Session #${selectedExchange.primary.session_id}`}
          compareBase={compareBase}
          onCompareBase={setCompareBase}
          onReplayed={onReplayed}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className={`toggle ${checked ? 'is-on' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}
