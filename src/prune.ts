import type { SessionFootprint, Store } from './store.js';

/**
 * Deciding which sessions to delete so the log stops growing: by age, by
 * count, or by size. Sessions that may still be running are always kept.
 */
export interface PruneRules {
  /** Delete sessions last active longer ago than this (ms). */
  olderThanMs?: number;
  /** Keep only this many of the most recently active sessions. */
  keep?: number;
  /** Delete the oldest sessions until the recorded data fits in this many bytes. */
  maxBytes?: number;
}

export interface PrunePlan {
  /** Sessions to delete, least recently active first. */
  sessions: SessionFootprint[];
  messages: number;
  /** Estimated space freed, in bytes of the log file. */
  bytes: number;
  /** Sessions in the log, before pruning. */
  total: number;
  /** Sessions kept although the rules matched them, because they may still be running. */
  running: number;
}

/** A session that hasn't ended and recorded something within this long may still be running. */
const MAYBE_RUNNING_MS = 60 * 60 * 1000;

export function planPrune(store: Store, rules: PruneRules, now = Date.now()): PrunePlan {
  const sessions = store.sessionFootprints(); // most recently active first
  const maybeRunning = (session: SessionFootprint) => session.ended_at === null && now - session.last_active < MAYBE_RUNNING_MS;
  const doomed = new Set<SessionFootprint>();

  sessions.forEach((session, index) => {
    if (rules.olderThanMs !== undefined && now - session.last_active > rules.olderThanMs) doomed.add(session);
    if (rules.keep !== undefined && index >= rules.keep) doomed.add(session);
  });

  // Payload bytes undercount the file (indexes, row overhead), so scale them by
  // how the file's used space compares with all the payloads it holds.
  const { fileBytes, freeBytes } = store.size();
  const used = fileBytes - freeBytes;
  const payloads = sessions.reduce((sum, session) => sum + session.bytes, 0);
  const scale = payloads > 0 ? used / payloads : 0;
  const footprint = (session: SessionFootprint) => session.bytes * scale;

  if (rules.maxBytes !== undefined && used > rules.maxBytes) {
    let freed = [...doomed].filter((session) => !maybeRunning(session)).reduce((sum, session) => sum + footprint(session), 0);
    for (const session of [...sessions].reverse()) {
      if (used - freed <= rules.maxBytes) break;
      if (doomed.has(session) || maybeRunning(session)) continue;
      doomed.add(session);
      freed += footprint(session);
    }
  }

  const chosen = sessions.filter((session) => doomed.has(session));
  const deleted = chosen.filter((session) => !maybeRunning(session)).reverse();
  return {
    sessions: deleted,
    messages: deleted.reduce((sum, session) => sum + session.message_count, 0),
    bytes: Math.round(deleted.reduce((sum, session) => sum + footprint(session), 0)),
    total: sessions.length,
    running: chosen.length - deleted.length,
  };
}

/**
 * Deletes the planned sessions, oldest first, pausing between batches so
 * proxies recording to the same log get the write lock in between (without
 * the pause, a waiting writer can lose the lock for seconds at a time).
 */
export async function applyPrune(store: Store, plan: PrunePlan, pauseMs = 20): Promise<void> {
  for (const session of plan.sessions) {
    while (!store.deleteSessionBatch(session.id)) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

/** Parses an age such as 12h, 30d or 8w into milliseconds. */
export function parseAge(text: string): number {
  const match = /^(\d+)\s*(h|d|w)$/i.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not an age; use hours, days or weeks, e.g. 12h, 30d or 8w`);
  const hours = { h: 1, d: 24, w: 24 * 7 }[match[2]!.toLowerCase() as 'h' | 'd' | 'w'];
  return Number(match[1]) * hours * 60 * 60 * 1000;
}

/** Parses a size such as 500MB or 2GB into bytes (1024-based, like the sizes mcpspy prints). */
export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB)$/i.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not a size; use KB, MB or GB, e.g. 500MB or 2GB`);
  const power = { KB: 1, MB: 2, GB: 3 }[match[2]!.toUpperCase() as 'KB' | 'MB' | 'GB'];
  return Math.round(Number(match[1]) * 1024 ** power);
}

/**
 * Rules from MCPSPY_RETENTION: an age, a size, or both separated by a comma
 * (e.g. "30d", "1GB" or "30d,1GB").
 */
export function parseRetention(text: string): PruneRules {
  const rules: PruneRules = {};
  for (const part of text.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    if (/^\d+\s*[hdw]$/i.test(part)) rules.olderThanMs = parseAge(part);
    else if (/^\d+(?:\.\d+)?\s*(?:KB|MB|GB)$/i.test(part)) rules.maxBytes = parseSize(part);
    else throw new Error(`"${part}" is neither an age (12h, 30d, 8w) nor a size (500MB, 2GB)`);
  }
  if (rules.olderThanMs === undefined && rules.maxBytes === undefined) throw new Error('MCPSPY_RETENTION is empty');
  return rules;
}
