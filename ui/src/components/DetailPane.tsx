import { useEffect, useState } from 'react';
import type { MessageDetail } from '../../../src/types.js';
import type { MessageRow } from '../../../src/types.js';
import type { Exchange } from '../exchanges';
import { formatBytes, formatClock, formatDuration } from '../format';
import { JsonTree, type Json } from './JsonTree';

type View = 'tree' | 'raw';

interface Props {
  exchange: Exchange;
  sessionName: string;
  onClose(): void;
}

export function DetailPane({ exchange, sessionName, onClose }: Props) {
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('tree');
  const responseId = exchange.response?.id;

  // Refetch when the response for a pending request arrives.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/messages/${exchange.id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as MessageDetail;
      })
      .then((data) => !cancelled && setDetail(data))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [exchange.id, responseId]);

  const { primary, response } = exchange;
  const latency = response?.latency_ms ?? primary.latency_ms;
  const current = detail?.message.id === exchange.id ? detail : null;
  const failure = response?.error ?? primary.error ?? (primary.kind === 'invalid' ? primary.problem : null);

  return (
    <aside className="detail" aria-label="Message detail">
      <header className="detail-header">
        <div>
          <h2 className="detail-title mono">
            {primary.kind === 'log' ? 'stderr' : (primary.method ?? 'response')}
            {primary.subject && <span className="subject"> {primary.subject}</span>}
          </h2>
          <p className="detail-meta">
            {sessionName} · {formatClock(primary.ts)}
            {latency !== null && <> · {formatDuration(latency)}</>}
            {primary.kind !== 'log' && <> · {formatBytes(primary.size + (response?.size ?? 0))}</>}
            {primary.rpc_id !== null && <> · id {primary.rpc_id}</>}
          </p>
        </div>
        <div className="detail-actions">
          <div className="segmented" role="group" aria-label="View">
            <button className={view === 'tree' ? 'is-on' : ''} onClick={() => setView('tree')}>
              Tree
            </button>
            <button className={view === 'raw' ? 'is-on' : ''} onClick={() => setView('raw')}>
              Raw
            </button>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close detail">
            ×
          </button>
        </div>
      </header>

      <div className="detail-body">
        {error && <p className="detail-error">Couldn't load message: {error}</p>}
        {failure && <p className="detail-failure mono">{failure}</p>}
        {!current && !error && <p className="muted">Loading…</p>}
        {current && <Sections detail={current} view={view} />}
      </div>
    </aside>
  );
}

function Sections({ detail, view }: { detail: MessageDetail; view: View }) {
  const { message, request, response } = detail;

  if (message.kind === 'log' || message.kind === 'invalid') {
    return (
      <Section title={message.kind === 'log' ? 'stderr line' : `Invalid frame: ${message.problem}`} row={message} view="raw" />
    );
  }

  const pending = request && !response;
  return (
    <>
      {request && <Section title={request.direction === 'client' ? 'Request from agent' : 'Request from server'} row={request} view={view} />}
      {response && <Section title="Response" row={response} view={view} showContent={request?.method === 'tools/call'} />}
      {!request && !response && <Section title={message.kind === 'notification' ? 'Notification' : 'Message'} row={message} view={view} />}
      {pending && <p className="muted">Waiting for a response…</p>}
    </>
  );
}

function Section({ title, row, view, showContent = false }: { title: string; row: MessageRow; view: View; showContent?: boolean }) {
  const [copied, setCopied] = useState(false);
  const parsed = parse(row.payload);

  const copy = async () => {
    await navigator.clipboard.writeText(parsed !== undefined ? JSON.stringify(parsed, null, 2) : row.payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.result : undefined;
  const content = showContent && result && typeof result === 'object' && !Array.isArray(result) ? result.content : undefined;

  return (
    <section className="detail-section">
      <div className="section-head">
        <h3 className="section-label">{title}</h3>
        <span className="muted mono">
          #{row.id} · {formatBytes(row.size)}
        </span>
        <button className="text-button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {Array.isArray(content) && <ContentBlocks blocks={content} />}
      {view === 'tree' && parsed !== undefined ? (
        <JsonTree value={parsed} expandDepth={4} />
      ) : (
        <pre className="raw mono">{parsed !== undefined ? JSON.stringify(parsed, null, 2) : row.payload}</pre>
      )}
    </section>
  );
}

/** Renders a tool result's content blocks the way an agent would see them. */
function ContentBlocks({ blocks }: { blocks: Json[] }) {
  return (
    <div className="content-blocks">
      {blocks.map((block, index) => {
        if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
        if (block.type === 'text' && typeof block.text === 'string') {
          return (
            <pre key={index} className="content-text">
              {block.text}
            </pre>
          );
        }
        if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
          return <img key={index} className="content-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Tool result image" />;
        }
        return (
          <div key={index} className="content-other mono">
            {String(block.type)} block
            {typeof block.uri === 'string' && <> · {block.uri}</>}
          </div>
        );
      })}
    </div>
  );
}

function parse(payload: string): Json | undefined {
  try {
    return JSON.parse(payload) as Json;
  } catch {
    return undefined;
  }
}
