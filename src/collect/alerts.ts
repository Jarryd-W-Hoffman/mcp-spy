import type { AlertBody, CollectorStore, QueuedAlert } from './store.js';

const TIMEOUT_MS = 10_000;
const FIRST_RETRY_MS = 30_000;
const LONGEST_RETRY_MS = 60 * 60 * 1000;
const MAX_DETAIL = 300;

/**
 * Chat services read <...> as links and mentions, such as <!channel>. Part of an
 * alert comes from the machine it's about, so a compromised machine could
 * otherwise ping a whole channel, or post a link that seems to be from mcpspy.
 */
function plain(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const clock = (ms: number) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/** The one line a person reads. */
export function alertText(alert: AlertBody): string {
  const machine = plain(alert.machine);
  switch (alert.kind) {
    case 'incident': {
      const { kind, seq, detail } = alert.incident!;
      const shown = detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail;
      const limit = alert.limit_reached ? " No more alerts for this machine for now; the collector's page lists every incident." : '';
      return `mcpspy: ${machine} was flagged: ${kind} at event ${seq}. ${plain(shown)}.${limit}`;
    }
    case 'silent':
      return `mcpspy: ${machine} has gone silent. Last heard from ${clock(alert.last_seen!)}.`;
    case 'recovered':
      return `mcpspy: ${machine} is pushing again.`;
  }
}

/**
 * Posts to the webhook. `text` is what Slack and Mattermost show, and `alert`
 * is there for anything that wants the fields. A redirect could carry the
 * alert elsewhere, and the address itself often holds a secret, so errors name
 * neither the address nor what it answered with.
 */
async function post(url: string, alert: AlertBody | { kind: 'test' }, text: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, alert }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new Error(`couldn't reach ${new URL(url).host}`);
  }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
}

export function sendTestAlert(url: string): Promise<void> {
  return post(url, { kind: 'test' }, 'mcpspy: this is a test alert from your collector.');
}

export interface AlertOptions {
  store: CollectorStore;
  url: string;
  /** Alert when a machine goes quiet for this long; null to leave silence to the page. */
  silentAfterMs: number | null;
  log(message: string): void;
  pollMs?: number;
  /** How long to wait after the first failure. */
  firstRetryMs?: number;
}

export interface Alerts {
  close(): Promise<void>;
}

/** How long to wait after this many failures: doubling, up to an hour. */
export function retryDelay(attempts: number, first = FIRST_RETRY_MS): number {
  return Math.min(first * 2 ** attempts, LONGEST_RETRY_MS);
}

/**
 * Sends queued alerts until closed. An alert leaves the queue only once the
 * webhook has accepted it, so a crash between the two can send it twice but
 * can't lose it. A failure holds the whole queue until the retry: the webhook is
 * probably down, and later alerts must not overtake the one that's waiting.
 */
export function startAlerts(options: AlertOptions): Alerts {
  const { store, url, silentAfterMs, log, pollMs = 5000, firstRetryMs } = options;
  const stopping = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let last = '';
  let heldUntil = 0;
  const say = (message: string) => {
    if (message !== last) log(message);
    last = message;
  };

  const deliver = async (alert: QueuedAlert): Promise<boolean> => {
    const body = JSON.parse(alert.body) as AlertBody;
    try {
      await post(url, body, alertText(body), stopping.signal);
    } catch (error) {
      if (stopping.signal.aborted) return false;
      const reason = (error as Error).message;
      heldUntil = Date.now() + retryDelay(alert.attempts, firstRetryMs);
      store.alertFailed(alert.id, heldUntil, reason);
      say(`alerts aren't getting through, will retry: ${reason}`);
      return false;
    }
    store.alertSent(alert.id);
    return true;
  };

  const round = async (): Promise<void> => {
    try {
      if (silentAfterMs !== null) store.noteSilentMachines(silentAfterMs);
      if (Date.now() < heldUntil) return;
      let delivered = false;
      for (const alert of store.dueAlerts()) {
        if (!(await deliver(alert))) return;
        delivered = true;
      }
      // Only an alert that went proves it: with nothing due, there's nothing to go on.
      if (delivered && last !== '') say('alerts are getting through again');
    } catch (error) {
      say(`couldn't process alerts, will retry: ${(error as Error).message}`);
    }
  };

  let running = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      running = round().then(() => {
        if (!stopping.signal.aborted) schedule();
      });
    }, pollMs);
  };
  schedule();

  return {
    close: async () => {
      stopping.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
