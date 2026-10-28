import { useState } from 'react';
import type { MessageRow } from '../../../src/types.js';

/** What POST /api/replay returns (see src/replay.ts). */
export interface ReplayOutcome {
  sessionId: number;
  original: { requestId: number; responseId: number | null; method: string };
  runs: { requestId: number | null; responseId: number | null; latencyMs: number }[];
  missingEnv: string[];
}

interface Props {
  request: MessageRow;
  onDone(outcome: ReplayOutcome): void;
  onCancel(): void;
}

/** Edits a recorded request's params and replays it against a fresh server. */
export function ReplayPanel({ request, onDone, onCancel }: Props) {
  const recorded = (JSON.parse(request.payload) as { params?: unknown }).params;
  const [text, setText] = useState(recorded === undefined ? '' : JSON.stringify(recorded, null, 2));
  const [repeat, setRepeat] = useState(1);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let parseError: string | null = null;
  let params: unknown;
  if (text.trim() !== '') {
    try {
      params = JSON.parse(text);
    } catch (reason) {
      parseError = (reason as Error).message;
    }
  }

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mcpspy': '1' },
        body: JSON.stringify({ messageId: request.id, params, repeat }),
      });
      const body = (await response.json()) as ReplayOutcome | { error: string; sessionId?: number | null };
      if (!response.ok || 'error' in body) {
        const failure = body as { error: string; sessionId?: number | null };
        throw new Error(failure.sessionId ? `${failure.error} (recorded as session #${failure.sessionId})` : failure.error);
      }
      onDone(body);
    } catch (reason) {
      setError((reason as Error).message);
      setRunning(false);
    }
  };

  return (
    <section className="detail-section replay">
      <div className="section-head">
        <h3 className="section-label">Replay {request.method}</h3>
      </div>
      <p className="card-note">Starts a fresh copy of the server, sends the agent's initialize, then this request. Ctrl+Enter runs it.</p>
      <label className="replay-label" htmlFor="replay-params">
        Params
      </label>
      <textarea
        id="replay-params"
        className="replay-editor mono"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !parseError && !running) void run();
        }}
        rows={Math.min(18, Math.max(5, text.split('\n').length + 1))}
      />
      {parseError && <p className="detail-error">Not valid JSON: {parseError}</p>}
      {error && <p className="detail-failure mono">{error}</p>}
      <div className="replay-actions">
        <label className="replay-repeat">
          Repeat
          <input type="number" min={1} max={100} value={repeat} onChange={(event) => setRepeat(Math.max(1, Number(event.target.value) || 1))} />
        </label>
        <button className="text-button" onClick={() => setText(recorded === undefined ? '' : JSON.stringify(recorded, null, 2))} disabled={running}>
          Reset
        </button>
        <button className="text-button" onClick={onCancel} disabled={running}>
          Cancel
        </button>
        <button className="primary-button" onClick={() => void run()} disabled={running || parseError !== null}>
          {running ? 'Running…' : 'Run replay'}
        </button>
      </div>
    </section>
  );
}
