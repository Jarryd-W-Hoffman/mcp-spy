// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDetail, MessageSummary, SessionSummary, ToolsReport } from '../../src/types.js';
import { App } from './App';
import type { ReplayOutcome } from './components/ReplayPanel';
import { FakeEventSource, row, session, stubFetch, summary } from './test/fixtures';

const messages: MessageSummary[] = [
  summary({ id: 1, session_id: 1 }),
  summary({ id: 2, session_id: 1, direction: 'server', kind: 'response', method: null, subject: null, request_id: 1 }),
  summary({ id: 3, session_id: 1, rpc_id: '2', subject: null, method: 'ping' }),
  summary({ id: 4, session_id: 1, direction: 'server', kind: 'response', method: null, subject: null, request_id: 3, error: 'nope' }),
  summary({ id: 5, session_id: 2, direction: 'server', kind: 'notification', method: 'notifications/message', subject: null, rpc_id: null }),
  summary({ id: 6, session_id: 2, direction: 'stderr', kind: 'log', method: null, subject: null, rpc_id: null, preview: 'booting' }),
  summary({ id: 7, session_id: 3, rpc_id: '7', issues: [{ severity: 'warning', path: '/', message: 'odd' }] }),
];
const sessions: SessionSummary[] = [session({ id: 3, name: null, command: '["srv"]' }), session({ id: 2, name: 'logs' }), session({ id: 1, name: 'files' })];
const tools: ToolsReport = { sessionId: 3, definitions: null, calls: [], previousSessionId: null, previousListMessageId: null, changes: null };
const request = row({ id: 1 });
const details: Record<string, MessageDetail> = {
  '/api/messages/1': { message: request, request, response: null },
  '/api/messages/1?listing': { message: request, request, response: null },
  '/api/messages/7?listing': { message: row({ id: 7 }), request: row({ id: 7 }), response: null },
};

let replies: ReplayOutcome[];

async function start(stream: { sessions?: SessionSummary[]; messages?: MessageSummary[] } = {}) {
  stubFetch({
    '/api/messages?tail=5000': stream.messages ?? messages,
    '/api/messages?session=1&tail=5000': [],
    '/api/messages?session=2&tail=5000': [],
    '/api/messages?session=9&tail=5000': [],
    '/api/sessions/3/tools': tools,
    '/api/sessions/1/tools': { ...tools, sessionId: 1 },
    '/api/replay': () => replies.shift(),
    ...details,
  });
  const view = render(<App />);
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  act(() => {
    FakeEventSource.latest.onopen!();
    FakeEventSource.latest.emit({ type: 'sessions', sessions: stream.sessions ?? sessions });
  });
  return view;
}

const rows = (container: HTMLElement) => [...container.querySelectorAll('tbody tr')].map((tr) => tr.getAttribute('data-id'));
const pick = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: 'Sessions' })).getByText(name));
const key = (name: string, target: Element | Window = window) => fireEvent.keyDown(target, { key: name });

describe('App', () => {
  beforeEach(() => {
    FakeEventSource.install();
    Element.prototype.scrollIntoView = vi.fn();
    replies = [];
  });

  it('shows the connection state', async () => {
    stubFetch({ '/api/messages?tail=5000': [] });
    const { container } = render(<App />);
    expect(container.querySelector('.connection')!.textContent).toBe('Connecting');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.latest.onopen!());
    expect(container.querySelector('.connection')!.textContent).toBe('Live');
    act(() => FakeEventSource.latest.onerror!());
    expect(container.querySelector('.connection')!.textContent).toBe('Reconnecting');
    expect(screen.getByText(/Nothing to show yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    expect(screen.getByText('No sessions yet.')).toBeTruthy();
  });

  it('filters traffic by search, kind, errors, issues and session', async () => {
    const { container } = await start();
    expect(rows(container)).toEqual(['1', '3', '5', '6', '7']);
    expect(screen.getByText('Errors only (1)')).toBeTruthy();
    expect(screen.getByText('Schema issues (1)')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Filter by method/), { target: { value: 'ping' } });
    expect(rows(container)).toEqual(['3']);
    expect(screen.getByText('Schema issues')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Filter by method/), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Notifications'));
    fireEvent.click(screen.getByLabelText('stderr'));
    expect(rows(container)).toEqual(['1', '3', '7']);
    fireEvent.click(screen.getByLabelText('Errors only (1)'));
    expect(rows(container)).toEqual(['3']);
    fireEvent.click(screen.getByLabelText('Errors only (1)'));
    fireEvent.click(screen.getByLabelText('Schema issues (1)'));
    expect(rows(container)).toEqual(['7']);
    expect(container.querySelector('.toggle.is-on')!.textContent).toBe('Schema issues (1)');
    fireEvent.click(screen.getByLabelText('Schema issues (1)'));
    pick('logs');
    expect(container.querySelector('.col-session')).toBeNull();
    expect(rows(container)).toEqual([]);
  });

  it('moves through rows with the arrow keys, closing with Escape', async () => {
    const { container } = await start();
    const selected = () => container.querySelector('tbody .is-selected')?.getAttribute('data-id') ?? null;
    key('ArrowUp');
    expect(selected()).toBe('7');
    key('ArrowDown');
    expect(selected()).toBe('7');
    key('ArrowUp');
    key('ArrowUp');
    expect(selected()).toBe('5');
    key('ArrowDown', screen.getByPlaceholderText(/Filter by method/));
    key('x');
    expect(selected()).toBe('5');
    expect(screen.getByLabelText('Message detail')).toBeTruthy();
    expect(container.querySelector('.detail-meta')!.textContent).toMatch(/^logs · /);
    key('Escape');
    expect(selected()).toBeNull();
    key('ArrowDown');
    expect(selected()).toBe('1');
    fireEvent.change(screen.getByPlaceholderText(/Filter by method/), { target: { value: 'nothing matches' } });
    key('ArrowDown');
    expect(container.querySelector('.app')!.className).toBe('app has-detail');
  });

  it('compares two rows, naming the base, and clears with Escape or the button', async () => {
    const { container } = await start();
    fireEvent.click(screen.getByText('booting'));
    fireEvent.click(container.querySelector('tr[data-id="1"]')!);
    fireEvent.click(await screen.findByText('Compare…'));
    expect(screen.getByText(/Comparing with tools\/call read \(files\)/)).toBeTruthy();
    fireEvent.click(container.querySelector('tr[data-id="7"]')!);
    await screen.findByText('Diff');
    key('Escape');
    expect(screen.queryByText(/Comparing with/)).toBeNull();
    expect(screen.getByLabelText('Message detail')).toBeTruthy();
    fireEvent.click(screen.getByText('Compare…'));
    expect(screen.getByText(/Comparing with tools\/call read\. Select/)).toBeTruthy();
    fireEvent.click(screen.getByText('Clear'));
    expect(screen.queryByText(/Comparing with/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Close detail'));
    expect(screen.queryByLabelText('Message detail')).toBeNull();
  });

  it('shows the tools of the selected or newest session, and diffs tool lists from there', async () => {
    const { container } = await start();
    fireEvent.click(screen.getByRole('tab', { name: /Tools/ }));
    expect(container.querySelector('.tab-note')!.textContent).toBe(' · #3');
    await screen.findByText('No tools/list recorded in this session.');
    pick('files');
    expect(container.querySelector('.tab-note')!.textContent).toBe(' · files');
    fireEvent.click(screen.getByRole('tab', { name: /Traffic/ }));
    expect(rows(container)).toEqual(['1', '3']);
  });

  it('opens a tool-list diff from the Tools tab, describing bases it cannot find', async () => {
    const changed = { ...tools, previousSessionId: 1, previousListMessageId: 99, definitions: { messageId: 8, requestId: 1, total: 1, tools: [] }, changes: [{ name: 'a', change: 'added' as const, fields: [], tokenDelta: 1 }] };
    stubFetch({ '/api/messages?tail=5000': messages, '/api/sessions/3/tools': changed, ...details });
    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.latest.emit({ type: 'sessions', sessions }));
    fireEvent.click(screen.getByRole('tab', { name: /Tools/ }));
    fireEvent.click(await screen.findByText('View diff'));
    expect(screen.getByText(/Comparing with message 99/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Tools/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('follows a replay to its result and explains missing environment', async () => {
    replies = [
      { sessionId: 9, original: { requestId: 1, responseId: 2, method: 'tools/call' }, runs: [{ requestId: 20, responseId: 21, latencyMs: 1 }], missingEnv: [] },
      { sessionId: 9, original: { requestId: 1, responseId: 2, method: 'tools/call' }, runs: [{ requestId: 20, responseId: 21, latencyMs: 1 }, { requestId: null, responseId: null, latencyMs: 1 }], missingEnv: ['TOKEN', 'HOME'] },
      { sessionId: 9, original: { requestId: 1, responseId: 2, method: 'tools/call' }, runs: [], missingEnv: [] },
    ];
    const { container } = await start();
    const replay = async () => {
      fireEvent.click(container.querySelector('tr[data-id="1"]')!);
      fireEvent.click(await screen.findByText('Replay…'));
      fireEvent.click(screen.getByText('Run replay'));
    };
    await replay();
    await screen.findByText('Replayed in session #9 (1 run).');
    expect(screen.getByText(/Comparing with tools\/call read \(files\)/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText(/Replayed/)).toBeNull();
    fireEvent.click(screen.getByText('Clear'));

    // With a session in view, the replay's session comes into view.
    pick('files');
    await replay();
    await screen.findByText(/Replayed in session #9 \(2 runs\)\. The original server had TOKEN, HOME set/);
    expect(rows(container)).toEqual([]);
    expect(screen.queryByText(/Comparing with/)).toBeNull();
    expect(screen.queryByText('Running…')).toBeNull();

    pick('All sessions');
    await replay();
    await screen.findByText('Replayed in session #9 (1 run).');
    expect(screen.queryByText(/Comparing with/)).toBeNull();
  });
});
