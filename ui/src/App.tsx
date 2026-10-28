import { useEffect, useMemo, useState } from 'react';
import { DetailPane } from './components/DetailPane';
import { ExchangeList } from './components/ExchangeList';
import { SessionList } from './components/SessionList';
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
  });
  const [selected, setSelected] = useState<number | null>(null);

  const exchanges = useMemo(() => buildExchanges(messages), [messages]);
  const visible = useMemo(() => filterExchanges(exchanges, filter), [exchanges, filter]);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const selectedExchange = exchanges.find((exchange) => exchange.id === selected) ?? null;
  const errorCount = useMemo(() => visible.filter((exchange) => exchange.status === 'error').length, [visible]);

  const update = (patch: Partial<ExchangeFilter>) => setFilter((previous) => ({ ...previous, ...patch }));

  // Arrow keys move through the list; Escape closes the detail pane.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') setSelected(null);
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const index = visible.findIndex((exchange) => exchange.id === selected);
      const next = event.key === 'ArrowDown' ? index + 1 : index === -1 ? visible.length - 1 : index - 1;
      const target = visible[Math.max(0, Math.min(visible.length - 1, next))];
      if (target) setSelected(target.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected]);

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
        </div>
        <span className={`connection connection-${connection}`}>
          <span className="dot" aria-hidden />
          {connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
        </span>
      </header>

      <SessionList sessions={sessions} selected={filter.sessionId} onSelect={(sessionId) => update({ sessionId })} />

      <main className="main">
        <ExchangeList
          exchanges={visible}
          sessions={sessionsById}
          showSession={filter.sessionId === null}
          selected={selected}
          onSelect={setSelected}
        />
      </main>

      {selectedExchange && (
        <DetailPane
          exchange={selectedExchange}
          sessionName={sessionsById.get(selectedExchange.primary.session_id)?.name ?? `Session #${selectedExchange.primary.session_id}`}
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
