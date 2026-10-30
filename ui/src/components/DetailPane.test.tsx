// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDetail, MessageRow, MessageSummary } from '../../../src/types.js';
import { buildExchanges, type Exchange } from '../exchanges';
import { row, Status, stubFetch, summary } from '../test/fixtures';
import { DetailPane } from './DetailPane';

const exchange = (...messages: MessageSummary[]): Exchange => buildExchanges(messages)[0]!;
const detail = (message: MessageRow, request: MessageRow | null = null, response: MessageRow | null = null): MessageDetail => ({ message, request, response });

const toolRequest = row();
const toolResponse = row({
  id: 2,
  direction: 'server',
  kind: 'response',
  request_id: 1,
  payload: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', uri: 'file:///a' },
        { type: 'audio' },
        'stray',
        null,
        [1],
      ],
    },
  }),
});

const pane = (props: Partial<Parameters<typeof DetailPane>[0]> & { exchange: Exchange }) => (
  <DetailPane sessionName="files" compareBase={null} onCompareBase={() => {}} onReplayed={() => {}} onClose={() => {}} {...props} />
);

describe('DetailPane', () => {
  it('shows a tool call with its result blocks, in tree and raw views', async () => {
    stubFetch({ '/api/messages/1': detail(toolRequest, toolRequest, toolResponse) });
    const onClose = vi.fn();
    const call = exchange(summary({ latency_ms: null }), summary({ id: 2, direction: 'server', kind: 'response', request_id: 1, latency_ms: 5, tokens: 2000, size: 30, mock: 'canned', issues: [{ severity: 'error', path: '/result', message: 'bad' }] }));
    const { container } = render(pane({ exchange: call, onClose }));
    expect(screen.getByText('Loading…')).toBeTruthy();
    await screen.findByText('Request from agent');
    expect(container.querySelector('.detail-title')!.textContent).toBe('tools/call read');
    expect(container.querySelector('.detail-meta')!.textContent).toBe('files · 03:04:05.006 · 5 ms · 130 B · id 1 · ≈2.0k tokens in context');
    expect(screen.getByText('canned')).toBeTruthy();
    expect(container.querySelector('.issue-error')!.textContent).toBe('error/resultbad');
    expect(screen.getByText('hello')).toBeTruthy();
    expect(container.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect([...container.querySelectorAll('.content-other')].map((block) => block.textContent)).toEqual(['resource block · file:///a', 'audio block']);
    expect(container.querySelectorAll('.json-tree')).toHaveLength(2);
    fireEvent.click(screen.getByText('Raw'));
    expect(container.querySelectorAll('.json-tree')).toHaveLength(0);
    expect(container.querySelector('pre.raw')!.textContent).toBe(JSON.stringify(JSON.parse(toolRequest.payload), null, 2));
    fireEvent.click(screen.getByText('Tree'));
    expect(container.querySelectorAll('.json-tree')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Close detail'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('copies a message, then resets the button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const invalid = row({ id: 3, kind: 'invalid', problem: 'not JSON', payload: '{oops', method: null });
    stubFetch({ '/api/messages/1': detail(toolRequest), '/api/messages/3': detail(invalid) });
    const { rerender } = render(pane({ exchange: exchange(summary()) }));
    await screen.findByText('Message');
    await act(async () => fireEvent.click(screen.getByText('Copy')));
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(JSON.parse(toolRequest.payload), null, 2));
    expect(screen.getByText('Copied')).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(1300));
    expect(screen.getByText('Copy')).toBeTruthy();

    rerender(pane({ exchange: exchange(summary({ id: 3, kind: 'invalid', method: null, subject: null, problem: 'not JSON', rpc_id: null })) }));
    await screen.findByText('Invalid frame: not JSON');
    await act(async () => fireEvent.click(screen.getByText('Copy')));
    expect(writeText).toHaveBeenLastCalledWith('{oops');
    expect(screen.getAllByText('not JSON')[0]!.className).toBe('detail-failure mono');
  });

  it('shows logs, notifications, server requests, pending requests and lone responses', async () => {
    const log = row({ id: 4, kind: 'log', direction: 'stderr', method: null, rpc_id: null, payload: 'warming up' });
    const note = row({ id: 5, kind: 'notification', direction: 'server', method: 'notifications/message', rpc_id: null, payload: '{"jsonrpc":"2.0","method":"notifications/message"}' });
    const serverRequest = row({ id: 6, direction: 'server', method: 'roots/list', payload: '{"jsonrpc":"2.0","id":1,"method":"roots/list"}' });
    const orphan = row({ id: 7, direction: 'server', kind: 'response', method: null, payload: '{"jsonrpc":"2.0","id":9,"result":5}' });
    const failed = row({ id: 8, direction: 'server', kind: 'error', method: null, payload: '{"jsonrpc":"2.0","id":9,"error":{}}' });
    stubFetch({
      '/api/messages/4': detail(log),
      '/api/messages/5': detail(note),
      '/api/messages/6': detail(serverRequest, serverRequest),
      '/api/messages/7': detail(orphan),
      '/api/messages/8': detail(failed, null, failed),
    });
    const { container, rerender } = render(pane({ exchange: exchange(summary({ id: 4, kind: 'log', direction: 'stderr', method: null, subject: null, rpc_id: null })) }));
    await screen.findByText('stderr line');
    expect(container.querySelector('.detail-title')!.textContent).toBe('stderr');
    expect(container.querySelector('.detail-meta')!.textContent).toBe('files · 03:04:05.006');
    expect(screen.queryByText('Compare…')).toBeNull();
    expect(screen.queryByText('Replay…')).toBeNull();
    expect(container.querySelector('pre.raw')!.textContent).toBe('warming up');

    rerender(pane({ exchange: exchange(summary({ id: 5, kind: 'notification', direction: 'server', method: 'notifications/message', subject: null, rpc_id: null })) }));
    await screen.findByText('Notification');
    rerender(pane({ exchange: exchange(summary({ id: 6, direction: 'server', method: 'roots/list', subject: null })) }));
    await screen.findByText('Request from server');
    expect(screen.getByText('Waiting for a response…')).toBeTruthy();
    expect(screen.queryByText('Replay…')).toBeNull();
    rerender(pane({ exchange: exchange(summary({ id: 7, direction: 'server', kind: 'response', method: null, subject: null, error: 'flagged' })) }));
    await screen.findByText('Message');
    expect(container.querySelector('.detail-title')!.textContent).toBe('response');
    expect(screen.getByText('flagged')).toBeTruthy();
    rerender(pane({ exchange: exchange(summary({ id: 8, direction: 'server', kind: 'error', method: null, subject: null })) }));
    await screen.findByText('Response');
  });

  it('offers no replay for initialize, and reports a failed load', async () => {
    stubFetch({ '/api/messages/1': new Status(500) });
    render(pane({ exchange: exchange(summary({ method: 'initialize', subject: null })) }));
    await screen.findByText("Couldn't load message: HTTP 500");
    expect(screen.queryByText('Replay…')).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('ignores replies and failures for a message no longer shown', async () => {
    const pending: ((value: unknown) => void)[] = [];
    stubFetch({ '/api/messages/1': () => new Promise((resolve) => pending.push(resolve)), '/api/messages/3': detail(row({ id: 3 })) });
    const { rerender } = render(pane({ exchange: exchange(summary()) }));
    rerender(pane({ exchange: exchange(summary({ id: 3 })) }));
    await screen.findByText('Message');
    rerender(pane({ exchange: exchange(summary()) }));
    rerender(pane({ exchange: exchange(summary({ id: 3 })) }));
    await screen.findByText('Message');
    pending[0]!(detail(toolRequest, toolRequest, toolResponse));
    pending[1]!(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText('Request from agent')).toBeNull();
    expect(screen.queryByText(/late/)).toBeNull();
  });

  it('replays the request, closing the editor when cancelled or another row is shown', async () => {
    stubFetch({ '/api/messages/1': detail(toolRequest, toolRequest), '/api/messages/3': detail(row({ id: 3 }), row({ id: 3 })) });
    const { rerender } = render(pane({ exchange: exchange(summary()) }));
    await screen.findByText('Request from agent');
    fireEvent.click(screen.getByText('Replay…'));
    expect(screen.getByText('Replay tools/call')).toBeTruthy();
    expect(screen.queryByText('Replay…')).toBeNull();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Replay tools/call')).toBeNull();
    fireEvent.click(screen.getByText('Replay…'));
    rerender(pane({ exchange: exchange(summary({ id: 3 })) }));
    await screen.findByText('Replay…');
    expect(screen.queryByText('Replay tools/call')).toBeNull();
  });

  it('starts, shows and clears a comparison', async () => {
    stubFetch({
      '/api/messages/1': detail(toolRequest, toolRequest),
      '/api/messages/1?listing': detail(toolRequest, toolRequest),
      '/api/messages/3?listing': detail(row({ id: 3 }), row({ id: 3 })),
    });
    const onCompareBase = vi.fn();
    const { container, rerender } = render(pane({ exchange: exchange(summary()), onCompareBase }));
    fireEvent.click(screen.getByText('Compare…'));
    expect(onCompareBase).toHaveBeenLastCalledWith(1);
    rerender(pane({ exchange: exchange(summary()), onCompareBase, compareBase: 1 }));
    fireEvent.click(screen.getByText('Comparing from here · Clear'));
    expect(onCompareBase).toHaveBeenLastCalledWith(null);

    rerender(pane({ exchange: exchange(summary()), onCompareBase, compareBase: 3 }));
    await screen.findByText('Identical');
    expect(screen.queryByText('Replay…')).toBeNull();
    expect(screen.queryByText('Tree')).toBeNull();
    fireEvent.click(screen.getByText('Message'));
    await waitFor(() => expect(container.querySelector('.json-tree')).not.toBeNull());
    expect(screen.getByText('Replay…')).toBeTruthy();
    fireEvent.click(screen.getByText('Diff'));
    await screen.findByText('Identical');
  });
});
