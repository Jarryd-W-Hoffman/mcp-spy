import { useEffect, useLayoutEffect, useRef } from 'react';
import type { SessionSummary } from '../../../src/types.js';
import type { Exchange } from '../exchanges';
import { formatBytes, formatClock, formatDuration } from '../format';

interface Props {
  exchanges: Exchange[];
  sessions: Map<number, SessionSummary>;
  showSession: boolean;
  selected: number | null;
  onSelect(id: number): void;
}

export function ExchangeList({ exchanges, sessions, showSession, selected, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new rows while the user is at the bottom, like `tail -f`.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [exchanges]);

  useEffect(() => {
    if (selected === null) return;
    scroller.current?.querySelector(`[data-id="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onScroll = () => {
    const element = scroller.current!;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };

  if (exchanges.length === 0) {
    return <div className="list-empty">Nothing to show yet. Traffic appears here as it happens.</div>;
  }

  return (
    <div className="list" ref={scroller} onScroll={onScroll}>
      <table>
        <thead>
          <tr>
            <th className="col-time">Time</th>
            {showSession && <th className="col-session">Server</th>}
            <th className="col-dir" aria-label="Direction" />
            <th>Message</th>
            <th className="col-status">Status</th>
            <th className="col-num">Latency</th>
            <th className="col-num col-size">Size</th>
          </tr>
        </thead>
        <tbody>
          {exchanges.map((exchange) => (
            <Row
              key={exchange.id}
              exchange={exchange}
              session={sessions.get(exchange.primary.session_id)}
              showSession={showSession}
              selected={exchange.id === selected}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  exchange,
  session,
  showSession,
  selected,
  onSelect,
}: {
  exchange: Exchange;
  session: SessionSummary | undefined;
  showSession: boolean;
  selected: boolean;
  onSelect(id: number): void;
}) {
  const { primary, response, status } = exchange;
  const size = primary.size + (response?.size ?? 0);
  const latency = response?.latency_ms ?? primary.latency_ms;

  return (
    <tr
      data-id={exchange.id}
      className={`row row-${primary.kind} ${selected ? 'is-selected' : ''} ${status === 'error' ? 'is-error' : ''}`}
      onClick={() => onSelect(exchange.id)}
    >
      <td className="col-time mono">{formatClock(primary.ts)}</td>
      {showSession && <td className="col-session">{session?.name ?? `#${primary.session_id}`}</td>}
      <td className="col-dir" title={directionLabel(primary.direction)}>
        {primary.direction === 'stderr' ? '!' : primary.direction === 'client' ? '→' : '←'}
      </td>
      <td className="col-message">
        <MessageLabel exchange={exchange} />
      </td>
      <td className="col-status">
        <StatusBadge exchange={exchange} />
      </td>
      <td className="col-num mono">{latency !== null ? formatDuration(latency) : ''}</td>
      <td className="col-num col-size mono">{primary.kind === 'log' ? '' : formatBytes(size)}</td>
    </tr>
  );
}

function MessageLabel({ exchange: { primary } }: { exchange: Exchange }) {
  if (primary.kind === 'log') return <span className="log-text mono">{primary.preview}</span>;
  if (primary.kind === 'invalid') {
    return (
      <span className="mono">
        <span className="invalid-label">{primary.problem}</span> {primary.preview}
      </span>
    );
  }
  return (
    <span className="mono">
      <span className={primary.kind === 'notification' ? 'method-quiet' : 'method'}>{primary.method ?? 'response'}</span>
      {primary.subject && <span className="subject"> {primary.subject}</span>}
      {primary.rpc_id !== null && <span className="rpc-id"> #{primary.rpc_id}</span>}
    </span>
  );
}

function StatusBadge({ exchange: { primary, response, status } }: { exchange: Exchange }) {
  const error = response?.error ?? primary.error;
  switch (status) {
    case 'pending':
      return <span className="badge badge-pending">pending</span>;
    case 'ok':
      return <span className="badge badge-ok">{primary.kind === 'request' ? 'ok' : 'unmatched'}</span>;
    case 'error':
      return (
        <span className="badge badge-error" title={error ?? primary.problem ?? undefined}>
          {primary.kind === 'invalid' ? 'invalid' : (error ?? 'error')}
        </span>
      );
    case 'none':
      return primary.kind === 'notification' ? <span className="badge badge-quiet">notify</span> : null;
  }
}

function directionLabel(direction: string): string {
  switch (direction) {
    case 'client':
      return 'Agent → server';
    case 'server':
      return 'Server → agent';
    default:
      return 'Server stderr';
  }
}
