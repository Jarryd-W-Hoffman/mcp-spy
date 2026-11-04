import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chainHash, GENESIS, verifyChain, type Anchor, type AuditEvent, type ChainReport } from '../audit.js';
import { keepPrivate } from '../store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked_at INTEGER,
  head_seq INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT
);

CREATE TABLE IF NOT EXISTS events (
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, seq)
);
CREATE INDEX IF NOT EXISTS events_received ON events(received_at);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  detail TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (machine_id, kind, seq, detail)
);

-- Stops accidents. The collector's own host is trusted: see the README.
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'collected events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'collected events are append-only');
END;
`;

export type IncidentKind = 'rewritten' | 'truncated' | 'gap' | 'tampered';

export interface Machine {
  id: number;
  name: string;
  created_at: number;
  last_seen: number | null;
  revoked_at: number | null;
  head_seq: number;
  head_hash: string | null;
}

export interface MachineSummary extends Machine {
  denied: number;
  /** Sessions with a start and no end: still running, or cut off. */
  open_sessions: number;
  incidents: number;
}

export interface Incident {
  id: number;
  machine: string;
  kind: IncidentKind;
  seq: number;
  detail: string;
  first_seen: number;
  last_seen: number;
  count: number;
}

export type CollectedEvent = AuditEvent & { machine: string; received_at: number };

export interface IngestResult {
  accepted: number;
  head: Anchor | null;
  /** What's wrong with what the machine sent. Everything before the first problem is kept. */
  problems: { kind: IncidentKind; seq: number; detail: string }[];
}

export function defaultCollectorDbPath(): string {
  return process.env.MCPSPY_COLLECT_DB ?? join(homedir(), '.mcpspy', 'collector.db');
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * What the collector holds: one append-only chain per machine, kept as first
 * received. Nothing a machine sends later can replace it; a machine whose
 * chain no longer lines up gets an incident instead.
 */
export class CollectorStore {
  private readonly db: DatabaseSync;

  constructor(path: string = defaultCollectorDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') keepPrivate(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Registers a machine and returns its token. Only a hash is kept, so this is the one chance to see it. */
  addMachine(name: string, now = Date.now()): string {
    const token = `mcs_${randomBytes(32).toString('base64url')}`;
    this.db.prepare('INSERT INTO machines (name, token_hash, created_at) VALUES (?, ?, ?)').run(name, hashToken(token), now);
    return token;
  }

  /** Stops a machine pushing. What it already sent stays. False when there's no such machine. */
  revokeMachine(name: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE machines SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL').run(now, name).changes > 0;
  }

  /** The machine a token belongs to, unless it was revoked. Tokens are random, so looking up their hash is safe. */
  machineForToken(token: string): Machine | undefined {
    return this.db.prepare('SELECT * FROM machines WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token)) as Machine | undefined;
  }

  machines(): MachineSummary[] {
    return this.db
      .prepare(
        `SELECT m.id, m.name, m.created_at, m.last_seen, m.revoked_at, m.head_seq, m.head_hash,
           (SELECT COUNT(*) FROM events e WHERE e.machine_id = m.id AND e.type = 'verdict' AND json_extract(e.data, '$.decision') = 'deny') AS denied,
           (SELECT COUNT(*) FROM events e WHERE e.machine_id = m.id AND e.type = 'session_start')
             - (SELECT COUNT(*) FROM events e WHERE e.machine_id = m.id AND e.type = 'session_end') AS open_sessions,
           (SELECT COUNT(*) FROM incidents i WHERE i.machine_id = m.id) AS incidents
         FROM machines m ORDER BY m.name`,
      )
      .all() as unknown as MachineSummary[];
  }

  incidents(limit = 100): Incident[] {
    return this.db
      .prepare(
        `SELECT i.id, m.name AS machine, i.kind, i.seq, i.detail, i.first_seen, i.last_seen, i.count
         FROM incidents i JOIN machines m ON m.id = i.machine_id ORDER BY i.last_seen DESC, i.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as Incident[];
  }

  /**
   * The latest events across machines, by when they arrived: an event's own time
   * is what its machine reported, so it can't be trusted to place the event.
   */
  events(filter: { machine?: string; denied?: boolean; limit: number }): CollectedEvent[] {
    return this.db
      .prepare(
        `SELECT e.seq, e.ts, e.session_id, e.type, e.data, e.prev_hash, e.hash, e.received_at, m.name AS machine
         FROM events e JOIN machines m ON m.id = e.machine_id
         WHERE (:machine IS NULL OR m.name = :machine)
           AND (:denied = 0 OR (e.type = 'verdict' AND json_extract(e.data, '$.decision') = 'deny'))
         ORDER BY e.received_at DESC, e.ts DESC, e.machine_id, e.seq DESC LIMIT :limit`,
      )
      .all({ machine: filter.machine ?? null, denied: filter.denied ? 1 : 0, limit: filter.limit }) as unknown as CollectedEvent[];
  }

  /**
   * Takes what a machine sent. Every event must follow on from what's held: the
   * one at the head again is how a machine shows its chain still contains what
   * the collector has. Valid events before a problem are kept, and the problem
   * becomes an incident, so a rewritten or cut-off chain can't replace anything.
   * `localHead` is where the machine says its chain ends now, and `localProblem`
   * what its own check of its chain found, if anything.
   */
  ingest(machine: Machine, events: AuditEvent[], localHead: Anchor | null, localProblem: string | null = null, now = Date.now()): IngestResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.ingestLocked(machine.id, events, localHead, localProblem, now);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ingestLocked(id: number, events: AuditEvent[], localHead: Anchor | null, localProblem: string | null, now: number): IngestResult {
    const row = this.db.prepare('SELECT head_seq, head_hash FROM machines WHERE id = ?').get(id) as { head_seq: number; head_hash: string | null };
    let head = { seq: row.head_seq, hash: row.head_hash };
    const problems: IngestResult['problems'] = [];
    const insert = this.db.prepare('INSERT INTO events (machine_id, seq, ts, session_id, type, data, prev_hash, hash, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const held = this.db.prepare('SELECT hash FROM events WHERE machine_id = ? AND seq = ?');
    let accepted = 0;

    for (const event of events) {
      if (chainHash(event) !== event.hash) {
        problems.push({ kind: 'tampered', seq: event.seq, detail: "the event's contents don't match its hash" });
        break;
      }
      if (event.seq <= head.seq) {
        // Sent before. It must be what's held, or the machine's chain has been rebuilt.
        const stored = held.get(id, event.seq) as { hash: string };
        if (stored.hash !== event.hash) {
          problems.push({ kind: 'rewritten', seq: event.seq, detail: `the machine now has ${event.hash} here; the collector received ${stored.hash}` });
          break;
        }
        continue;
      }
      if (event.seq !== head.seq + 1) {
        problems.push({ kind: 'gap', seq: event.seq, detail: `expected event ${head.seq + 1} next` });
        break;
      }
      if ((head.hash ?? GENESIS) !== event.prev_hash) {
        problems.push({ kind: 'tampered', seq: event.seq, detail: `it doesn't follow event ${head.seq}: its previous hash differs` });
        break;
      }
      insert.run(id, event.seq, event.ts, event.session_id, event.type, event.data, event.prev_hash, event.hash, now);
      head = { seq: event.seq, hash: event.hash };
      accepted++;
    }

    // Only claims about the end of the chain that the events sent didn't already settle.
    if (problems.length === 0) {
      if ((localHead?.seq ?? 0) < head.seq) {
        problems.push({ kind: 'truncated', seq: head.seq, detail: `the machine's chain now ends at event ${localHead?.seq ?? 0}` });
      } else if (localHead?.seq === head.seq && localHead.hash !== head.hash) {
        problems.push({ kind: 'rewritten', seq: head.seq, detail: `the machine now has ${localHead.hash} here; the collector received ${head.hash}` });
      }
    }

    if (localProblem !== null) problems.push({ kind: 'tampered', seq: localHead?.seq ?? 0, detail: `the machine's own check of its chain says: ${localProblem}` });

    const record = this.db.prepare(
      `INSERT INTO incidents (machine_id, kind, seq, detail, first_seen, last_seen) VALUES (:id, :kind, :seq, :detail, :now, :now)
       ON CONFLICT (machine_id, kind, seq, detail) DO UPDATE SET last_seen = :now, count = count + 1`,
    );
    for (const problem of problems) record.run({ id, now, ...problem });
    this.db.prepare('UPDATE machines SET head_seq = ?, head_hash = ?, last_seen = ? WHERE id = ?').run(head.seq, head.hash, now, id);
    return { accepted, head: head.seq === 0 ? null : { seq: head.seq, hash: head.hash! }, problems };
  }

  /** Re-checks each machine's held chain, which finds changes made directly to the collector's own file. */
  verify(): { machine: string; report: ChainReport }[] {
    const results: { machine: string; report: ChainReport }[] = [];
    for (const machine of this.machines()) {
      const events = this.db.prepare('SELECT seq, ts, session_id, type, data, prev_hash, hash FROM events WHERE machine_id = ? ORDER BY seq').iterate(machine.id) as unknown as Iterable<AuditEvent>;
      const report = verifyChain(events, machine.head_seq > 0 ? { seq: machine.head_seq, hash: machine.head_hash! } : undefined);
      results.push({ machine: machine.name, report });
    }
    return results;
  }
}
