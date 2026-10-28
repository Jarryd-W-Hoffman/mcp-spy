import { useState } from 'react';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Props {
  value: Json;
  /** Levels expanded on first render. */
  expandDepth?: number;
}

export function JsonTree({ value, expandDepth = 2 }: Props) {
  return (
    <div className="json-tree mono">
      <Node value={value} depth={0} expandDepth={expandDepth} label={null} last />
    </div>
  );
}

function Node({
  value,
  label,
  depth,
  expandDepth,
  last,
}: {
  value: Json;
  label: string | null;
  depth: number;
  expandDepth: number;
  last: boolean;
}) {
  const [open, setOpen] = useState(depth < expandDepth);
  const comma = last ? '' : ',';
  const key = label !== null ? <span className="json-key">{label}: </span> : null;

  if (value === null || typeof value !== 'object') {
    return (
      <div className="json-line">
        {key}
        <Scalar value={value} expandDepth={expandDepth} depth={depth} />
        {comma}
      </div>
    );
  }

  const entries: [string | null, Json][] = Array.isArray(value)
    ? value.map((item) => [null, item])
    : Object.entries(value);
  const [openBrace, closeBrace] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  if (entries.length === 0) {
    return (
      <div className="json-line">
        {key}
        {openBrace}
        {closeBrace}
        {comma}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="json-line">
        <button className="json-toggle" onClick={() => setOpen(true)} aria-label="Expand">
          ▸
        </button>
        {key}
        {openBrace}
        <button className="json-summary" onClick={() => setOpen(true)}>
          {Array.isArray(value) ? `${entries.length} items` : `${entries.length} keys`}
        </button>
        {closeBrace}
        {comma}
      </div>
    );
  }

  return (
    <div>
      <div className="json-line">
        <button className="json-toggle" onClick={() => setOpen(false)} aria-label="Collapse">
          ▾
        </button>
        {key}
        {openBrace}
      </div>
      <div className="json-children">
        {entries.map(([childLabel, child], index) => (
          <Node
            key={childLabel ?? index}
            value={child}
            label={childLabel !== null ? JSON.stringify(childLabel) : null}
            depth={depth + 1}
            expandDepth={expandDepth}
            last={index === entries.length - 1}
          />
        ))}
      </div>
      <div className="json-line">
        {closeBrace}
        {comma}
      </div>
    </div>
  );
}

const LONG_STRING = 400;

function Scalar({ value, depth, expandDepth }: { value: Exclude<Json, object>; depth: number; expandDepth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [parsed, setParsed] = useState(false);

  if (typeof value !== 'string') {
    return <span className={`json-${value === null ? 'null' : typeof value}`}>{String(value)}</span>;
  }

  // Tools often return JSON as a text block; offer to view it as a tree.
  const embedded = embeddedJson(value);
  if (parsed && embedded !== undefined) {
    return (
      <span>
        <button className="json-chip" onClick={() => setParsed(false)}>
          as string
        </button>
        <Node value={embedded} label={null} depth={depth} expandDepth={expandDepth} last />
      </span>
    );
  }

  const long = value.length > LONG_STRING;
  const shown = long && !expanded ? `${value.slice(0, LONG_STRING)}…` : value;
  return (
    <span>
      <span className="json-string">{JSON.stringify(shown)}</span>
      {long && (
        <button className="json-chip" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'less' : `+${(value.length - LONG_STRING).toLocaleString()} chars`}
        </button>
      )}
      {embedded !== undefined && (
        <button className="json-chip" onClick={() => setParsed(true)}>
          parse JSON
        </button>
      )}
    </span>
  );
}

function embeddedJson(text: string): Json | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as Json;
  } catch {
    return undefined;
  }
}

export type { Json };
