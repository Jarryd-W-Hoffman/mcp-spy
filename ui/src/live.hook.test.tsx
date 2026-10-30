// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveData } from './live';
import { FakeEventSource, session, stubFetch, summary } from './test/fixtures';

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const sessions = (from: number, count: number) => Array.from({ length: count }, (_, i) => session({ id: from - i }));

describe('useLiveData', () => {
  beforeEach(() => FakeEventSource.install());

  it('loads recent messages, then follows the event stream', async () => {
    stubFetch({ '/api/messages?tail=5000': [summary({ id: 1 }), summary({ id: 2 })] });
    const { result } = renderHook(() => useLiveData());
    expect(result.current.connection).toBe('connecting');
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]));
    const source = FakeEventSource.latest;
    expect(source.url).toBe('/api/events?after=2');
    act(() => source.onopen!());
    expect(result.current.connection).toBe('live');
    act(() => source.emit({ type: 'messages', messages: [summary({ id: 2 }), summary({ id: 3 })] }));
    act(() => source.emit({ type: 'messages', messages: [summary({ id: 3 })] }));
    act(() => source.emit({ type: 'sessions', sessions: [session()] }));
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(result.current.sessions).toEqual([session({ started_at: result.current.sessions[0]!.started_at })]);
    expect(result.current.moreSessions).toBe(false);
  });

  it('reconnects after an error, asking only for newer messages, and stops when unmounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ '/api/messages?tail=5000': [summary({ id: 5 })] });
    const { result, unmount } = renderHook(() => useLiveData());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.latest;
    act(() => first.onerror!());
    expect(first.closed).toBe(true);
    expect(result.current.connection).toBe('offline');
    await act(async () => vi.advanceTimersByTime(1500));
    expect(FakeEventSource.latest.url).toBe('/api/events?after=5');
    const second = FakeEventSource.latest;
    unmount();
    expect(second.closed).toBe(true);
    second.onerror!();
    await act(async () => vi.advanceTimersByTime(3000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('retries when the first load fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ '/api/messages?tail=5000': new Error('offline') });
    const { result } = renderHook(() => useLiveData());
    await waitFor(() => expect(result.current.connection).toBe('offline'));
    expect(FakeEventSource.instances).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1500));
    expect(FakeEventSource.latest.url).toBe('/api/events?after=0');
  });

  it('does nothing once unmounted before the first load settles', async () => {
    const replies: ((value: unknown) => void)[] = [];
    stubFetch({ '/api/messages?tail=5000': () => new Promise((resolve) => replies.push(resolve)) });
    const first = renderHook(() => useLiveData());
    first.unmount();
    const second = renderHook(() => useLiveData());
    second.unmount();
    replies[0]!([summary()]);
    replies[1]!(new Error('offline'));
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("loads the selected session's messages, forgetting what it drops so they load again", async () => {
    const many = Array.from({ length: 20_001 }, (_, i) => summary({ id: i + 10, session_id: 2 }));
    const replies: Record<string, unknown> = {
      '/api/messages?tail=5000': [],
      '/api/messages?session=1&tail=5000': [summary({ id: 1 }), summary({ id: 2 })],
      '/api/messages?session=3&tail=5000': new Error('offline'),
    };
    stubFetch(replies);
    const { result, rerender } = renderHook(({ id }) => useLiveData(id), { initialProps: { id: null as number | null } });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.latest.emit({ type: 'messages', messages: many.slice(0, 3) }));
    rerender({ id: 1 });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual([1, 2, 10, 11, 12]));
    // Viewing another session, a flood drops session 1's messages; selecting it again fetches them again.
    rerender({ id: 3 });
    await flush();
    act(() => FakeEventSource.latest.emit({ type: 'messages', messages: many.slice(3) }));
    expect(result.current.messages[0]!.id).toBe(11);
    rerender({ id: 1 });
    await waitFor(() => expect(result.current.messages[0]!.id).toBe(1));
  });

  it('ignores a session load that arrives after another session is selected', async () => {
    let late!: (value: unknown) => void;
    stubFetch({
      '/api/messages?tail=5000': [],
      '/api/messages?session=1&tail=5000': new Promise((resolve) => (late = resolve)),
      '/api/messages?session=2&tail=5000': [],
    });
    const { result, rerender } = renderHook(({ id }) => useLiveData(id), { initialProps: { id: 1 } });
    rerender({ id: 2 });
    late([summary({ id: 7 })]);
    await flush();
    expect(result.current.messages).toEqual([]);
  });

  it('pages through older sessions', async () => {
    const pages: Record<string, unknown> = {
      '/api/messages?tail=5000': [],
      '/api/sessions?before=201': [...sessions(205, 5), ...sessions(200, 195)],
      '/api/sessions?before=6': sessions(5, 3),
      '/api/sessions?before=3': new Error('offline'),
    };
    stubFetch(pages);
    const { result } = renderHook(() => useLiveData());
    act(() => result.current.loadOlderSessions());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.latest.emit({ type: 'sessions', sessions: sessions(400, 200) }));
    expect(result.current.moreSessions).toBe(true);
    act(() => result.current.loadOlderSessions());
    // The overlap with the live page is dropped.
    await waitFor(() => expect(result.current.sessions).toHaveLength(395));
    expect(result.current.moreSessions).toBe(true);
    act(() => result.current.loadOlderSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(398));
    expect(result.current.moreSessions).toBe(false);
    act(() => result.current.loadOlderSessions());
    await flush();
    expect(result.current.sessions).toHaveLength(398);
  });
});
