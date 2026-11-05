export type { Direction, MessageKind } from './types.js';
export type { Verdict } from './policy.js';

export type AuditType = 'session_start' | 'session_end' | 'call' | 'verdict' | 'approval' | 'outcome';

export interface AuditEvent {
  seq: number;
  ts: number;
  session_id: number;
  type: AuditType;
  /** JSON text; hashed as stored. */
  data: string;
  prev_hash: string;
  hash: string;
}
