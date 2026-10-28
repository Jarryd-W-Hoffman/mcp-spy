import type { SessionSummary } from '../../../src/types.js';
import { formatRelative } from '../format';

interface Props {
  sessions: SessionSummary[];
  selected: number | null;
  onSelect(id: number | null): void;
}

export function SessionList({ sessions, selected, onSelect }: Props) {
  const total = sessions.reduce((sum, session) => sum + session.message_count, 0);

  return (
    <nav className="sessions" aria-label="Sessions">
      <h2 className="section-label">Sessions</h2>
      <button className={`session ${selected === null ? 'is-selected' : ''}`} onClick={() => onSelect(null)}>
        <span className="session-name">All sessions</span>
        <span className="session-meta">{total} messages</span>
      </button>
      {sessions.map((session) => {
        const running = session.ended_at === null;
        const failed = !running && (session.exit_signal !== null || session.exit_code !== 0);
        const command = (JSON.parse(session.command) as string[]).join(' ');
        return (
          <button
            key={session.id}
            className={`session ${selected === session.id ? 'is-selected' : ''}`}
            onClick={() => onSelect(session.id)}
            title={`${command}\n${session.cwd}`}
          >
            <span className="session-name">
              <span className={`dot ${running ? 'dot-live' : failed ? 'dot-error' : 'dot-idle'}`} aria-hidden />
              {session.name ?? command.split(' ')[0]}
              <span className="session-id">#{session.id}</span>
              {session.replay_of !== null && <span className="session-tag">replay of #{session.replay_of}</span>}
            </span>
            <span className="session-meta">
              {session.message_count} messages · {running ? 'running' : failed ? (session.exit_signal ?? `exit ${session.exit_code}`) : 'exited'} ·{' '}
              {formatRelative(session.started_at)}
            </span>
          </button>
        );
      })}
      {sessions.length === 0 && (
        <p className="empty-hint">
          No sessions yet. Wrap a server with <code>mcpspy run -- &lt;command&gt;</code>.
        </p>
      )}
    </nav>
  );
}
