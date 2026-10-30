// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { row, Status, stubFetch } from '../test/fixtures';
import { ReplayPanel, type ReplayOutcome } from './ReplayPanel';

const outcome: ReplayOutcome = { sessionId: 9, original: { requestId: 1, responseId: 2, method: 'tools/call' }, runs: [], missingEnv: [] };
const editor = () => screen.getByLabelText('Params') as HTMLTextAreaElement;

describe('ReplayPanel', () => {
  it('replays edited params, repeated', async () => {
    const fetch = stubFetch({ '/api/replay': outcome });
    const onDone = vi.fn();
    render(<ReplayPanel request={row()} onDone={onDone} onCancel={() => {}} />);
    expect(editor().value).toBe('{\n  "name": "read"\n}');
    fireEvent.change(editor(), { target: { value: '{"name":"write"}' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Run replay'));
    expect(screen.getByText('Running…')).toBeTruthy();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(outcome));
    const [, init] = fetch.mock.calls[0]!;
    expect(init!.headers).toMatchObject({ 'x-mcpspy': '1' });
    expect(JSON.parse(init!.body as string)).toEqual({ messageId: 1, params: { name: 'write' }, repeat: 3 });
  });

  it('runs with Ctrl or Cmd+Enter, unless the JSON is invalid or a run is going', async () => {
    let answer!: (value: unknown) => void;
    const fetch = stubFetch({ '/api/replay': () => new Promise((resolve) => (answer = resolve)) });
    render(<ReplayPanel request={row({ payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}', method: 'ping' })} onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Replay ping')).toBeTruthy();
    expect(editor().value).toBe('');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    fireEvent.change(editor(), { target: { value: '{nope' } });
    expect(screen.getByText(/^Not valid JSON:/)).toBeTruthy();
    expect((screen.getByText('Run replay') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Reset'));
    expect(editor().value).toBe('');
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ messageId: 1, repeat: 1 });
    answer(outcome);
  });

  it('shows failures, naming the session they were recorded as', async () => {
    const replies = [new Status(500, { error: 'server crashed', sessionId: 4 }), new Status(400, { error: 'bad request' }), { error: 'odd', sessionId: null }, new Error('offline')];
    stubFetch({ '/api/replay': () => replies.shift() });
    const onCancel = vi.fn();
    render(<ReplayPanel request={row()} onDone={() => {}} onCancel={onCancel} />);
    for (const message of ['server crashed (recorded as session #4)', 'bad request', 'odd', 'offline']) {
      fireEvent.click(screen.getByText('Run replay'));
      await screen.findByText(message);
    }
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: 'x' } });
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('1');
    fireEvent.change(editor(), { target: { value: '{}' } });
    fireEvent.click(screen.getByText('Reset'));
    expect(editor().value).toBe('{\n  "name": "read"\n}');
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
