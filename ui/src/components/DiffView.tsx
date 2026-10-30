import { useEffect, useMemo, useState } from 'react';
import { comparableBody, diffJson, diffLines, hunks, jsonLines, type JsonChange } from '../../../src/diff.js';
import type { MessageDetail, MessageRow } from '../../../src/types.js';

interface Props {
  baseId: number;
  targetId: number;
}

/** Compares two exchanges: request arguments, then responses. */
export function DiffView({ baseId, targetId }: Props) {
  const [details, setDetails] = useState<[MessageDetail, MessageDetail] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    // ?listing: a tool list sent in pages is compared as a whole, not first page to first page.
    const load = (id: number) =>
      fetch(`/api/messages/${id}?listing`).then(async (response) => {
        if (!response.ok) throw new Error(`message #${id}: HTTP ${response.status}`);
        return (await response.json()) as MessageDetail;
      });
    Promise.all([load(baseId), load(targetId)])
      .then((loaded) => !cancelled && setDetails(loaded))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [baseId, targetId]);

  if (error) return <p className="detail-error">Couldn't load: {error}</p>;
  if (!details) return <p className="muted">Loading…</p>;

  const [base, target] = details;
  const sides = (detail: MessageDetail) =>
    detail.request || detail.response ? { request: detail.request, response: detail.response } : { request: detail.message, response: null };
  const a = sides(base);
  const b = sides(target);

  return (
    <>
      <DiffSection title="Request" before={a.request} after={b.request} />
      <DiffSection title="Response" before={a.response} after={b.response} />
    </>
  );
}

function DiffSection({ title, before, after }: { title: string; before: MessageRow | null; after: MessageRow | null }) {
  const diff = useMemo(() => {
    if (!before || !after) return null;
    const left = comparableBody(before.payload);
    const right = comparableBody(after.payload);
    return { changes: diffJson(left, right), hunks: hunks(diffLines(jsonLines(left), jsonLines(right))) };
  }, [before, after]);

  return (
    <section className="detail-section">
      <div className="section-head">
        <h3 className="section-label">{title}</h3>
        {before && after && (
          <span className="muted mono">
            #{before.id} → #{after.id}
          </span>
        )}
      </div>
      {!diff ? (
        <p className="muted">Missing on {before ? 'the compared' : 'the base'} side.</p>
      ) : diff.changes.length === 0 ? (
        <p className="diff-same">Identical</p>
      ) : (
        <>
          <ChangeList changes={diff.changes} />
          <div className="diff mono">
            {diff.hunks.map((hunk, index) => (
              <div key={index} className="diff-hunk">
                <div className="diff-hunk-head">
                  @@ −{hunk.beforeStart} +{hunk.afterStart} @@
                </div>
                {hunk.ops.map((op, opIndex) => (
                  <div key={opIndex} className={`diff-line diff-${op.type}`}>
                    <span className="diff-num">{op.beforeLine ?? ''}</span>
                    <span className="diff-num">{op.afterLine ?? ''}</span>
                    <span className="diff-sign">{op.type === 'insert' ? '+' : op.type === 'delete' ? '−' : ' '}</span>
                    <span className="diff-text">{op.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ChangeList({ changes }: { changes: JsonChange[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? changes : changes.slice(0, 8);
  return (
    <ul className="change-list">
      {shown.map((change, index) => (
        <li key={index} className={`change change-${change.type}`}>
          <span className="change-type">{change.type === 'added' ? '+' : change.type === 'removed' ? '−' : '~'}</span>
          <span className="mono">{change.path}</span>
          {change.type === 'changed' && (
            <span className="change-values mono">
              {preview(change.before)} → {preview(change.after)}
            </span>
          )}
        </li>
      ))}
      {changes.length > 8 && (
        <li>
          <button className="text-button" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show fewer' : `${changes.length - 8} more changes`}
          </button>
        </li>
      )}
    </ul>
  );
}

function preview(value: unknown): string {
  // Values come from parsed JSON, so they always serialise.
  const text = JSON.stringify(value)!;
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
