import { useEffect, useState } from 'react';
import type { MessageSummary, ServerEvent, SessionSummary } from '../../src/types.js';

export type ConnectionState = 'connecting' | 'live' | 'offline';

const MAX_MESSAGES = 20_000;

interface LiveData {
  messages: MessageSummary[];
  sessions: SessionSummary[];
  connection: ConnectionState;
}

/**
 * Loads recent messages, then follows the server's event stream. On a dropped
 * connection it reconnects asking only for what it hasn't seen yet.
 */
export function useLiveData(): LiveData {
  const [state, setState] = useState<LiveData>({ messages: [], sessions: [], connection: 'connecting' });

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
        let messages = [...previous.messages, ...fresh];
        if (fresh[0]!.id < (previous.messages.at(-1)?.id ?? 0)) messages.sort((a, b) => a.id - b.id);
        if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
        return { ...previous, messages };
      });
    };

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

  return state;
}
