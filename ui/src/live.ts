import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessageSummary, ServerEvent, SessionSummary } from '../../src/types.js';

export type ConnectionState = 'connecting' | 'live' | 'offline';

const MAX_MESSAGES = 20_000;
/** Sessions the server sends at a time, live and per page of older ones. */
const SESSION_PAGE = 200;

interface LiveData {
  messages: MessageSummary[];
  sessions: SessionSummary[];
  connection: ConnectionState;
}

interface LiveSessions extends LiveData {
  /** Whether there may be sessions older than those listed. */
  moreSessions: boolean;
  loadOlderSessions(): void;
}

/**
 * Adds fresh messages to those held, in id order, keeping at most `max`: the
 * newest, plus every message of `keepSession` (the one in view), whatever its age.
 */
export function mergeMessages(
  held: MessageSummary[],
  fresh: MessageSummary[],
  keepSession: number | null,
  max = MAX_MESSAGES,
): { messages: MessageSummary[]; dropped: MessageSummary[] } {
  let messages = [...held, ...fresh];
  if (fresh.length > 0 && fresh[0]!.id < (held.at(-1)?.id ?? 0)) messages.sort((a, b) => a.id - b.id);
  if (messages.length <= max) return { messages, dropped: [] };

  const cutoff = messages.length - max;
  const dropped = messages.filter((message, index) => index < cutoff && message.session_id !== keepSession);
  const gone = new Set(dropped);
  return { messages: messages.filter((message) => !gone.has(message)), dropped };
}

/**
 * Loads recent messages, then follows the server's event stream. On a dropped
 * connection it reconnects asking only for what it hasn't seen yet. Selecting
 * a session loads its messages too, since older sessions fall outside the
 * recent ones.
 */
export function useLiveData(sessionId: number | null = null): LiveSessions {
  const [state, setState] = useState<LiveData>({ messages: [], sessions: [], connection: 'connecting' });
  // Pages of sessions older than the newest ones, which the server streams.
  const [older, setOlder] = useState<{ sessions: SessionSummary[]; more: boolean }>({ sessions: [], more: true });
  const mergeRef = useRef<(incoming: MessageSummary[]) => void>(() => {});
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const seen = new Set<number>();
    let lastId = 0;

    const merge = (incoming: MessageSummary[]) => {
      const fresh = incoming.filter((message) => !seen.has(message.id));
      if (fresh.length === 0) return;
      for (const message of fresh) {
        seen.add(message.id);
        lastId = Math.max(lastId, message.id);
      }
      setState((previous) => {
        const { messages, dropped } = mergeMessages(previous.messages, fresh, sessionRef.current);
        // Forgotten, so selecting their session again fetches them again.
        for (const message of dropped) seen.delete(message.id);
        return { ...previous, messages };
      });
    };
    mergeRef.current = merge;

    const connect = () => {
      source = new EventSource(`/api/events?after=${lastId}`);
      source.onopen = () => setState((previous) => ({ ...previous, connection: 'live' }));
      source.onmessage = (event: MessageEvent<string>) => {
        const data = JSON.parse(event.data) as ServerEvent;
        if (data.type === 'messages') merge(data.messages);
        else setState((previous) => ({ ...previous, sessions: data.sessions }));
      };
      source.onerror = () => {
        source?.close();
        setState((previous) => ({ ...previous, connection: 'offline' }));
        if (!cancelled) retry = setTimeout(connect, 1500);
      };
    };

    fetch('/api/messages?tail=5000')
      .then((response) => response.json() as Promise<MessageSummary[]>)
      .then((messages) => {
        if (cancelled) return;
        merge(messages);
        connect();
      })
      .catch(() => {
        if (cancelled) return;
        setState((previous) => ({ ...previous, connection: 'offline' }));
        retry = setTimeout(connect, 1500);
      });

    return () => {
      cancelled = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    fetch(`/api/messages?session=${sessionId}&tail=5000`)
      .then((response) => response.json() as Promise<MessageSummary[]>)
      .then((messages) => {
        if (!cancelled) mergeRef.current(messages);
      })
      .catch(() => {
        // The event stream reports the server going away.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const sessions = useMemo(() => {
    const oldestLive = state.sessions.at(-1)?.id ?? Infinity;
    return [...state.sessions, ...older.sessions.filter((session) => session.id < oldestLive)];
  }, [state.sessions, older.sessions]);
  const moreSessions = older.sessions.length === 0 ? state.sessions.length >= SESSION_PAGE : older.more;

  const oldest = sessions.at(-1)?.id;
  const loadOlderSessions = useCallback(() => {
    if (oldest === undefined) return;
    fetch(`/api/sessions?before=${oldest}`)
      .then((response) => response.json() as Promise<SessionSummary[]>)
      .then((page) => setOlder((previous) => ({ sessions: [...previous.sessions, ...page], more: page.length >= SESSION_PAGE })))
      .catch(() => {
        // The event stream reports the server going away.
      });
  }, [oldest]);

  return { ...state, sessions, moreSessions, loadOlderSessions };
}
