// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../test/fixtures';
import { SessionList } from './SessionList';

describe('SessionList', () => {
  it('describes each session: state, exit, transport and origin', () => {
    const sessions = [
      session({ id: 1 }),
      session({ id: 2, ended_at: 1, exit_code: 0, message_count: 1 }),
      session({ id: 3, ended_at: 1, exit_code: 3 }),
      session({ id: 4, ended_at: 1, exit_signal: 'SIGKILL' }),
      session({ id: 5, ended_at: 1, transport: 'http', name: null, command: '["http://x/mcp"]' }),
      session({ id: 6, transport: 'sse' }),
      session({ id: 7, transport: 'mock' }),
      session({ id: 8, replay_of: 1 }),
    ];
    const onSelect = vi.fn();
    const { container } = render(<SessionList sessions={sessions} selected={3} onSelect={onSelect} more={false} onShowOlder={() => {}} />);
    const meta = [...container.querySelectorAll('.session-meta')].map((element) => element.textContent!.split(' · ').slice(0, 2).join(' · '));
    expect(meta).toEqual([
      '15 messages',
      '2 messages · running',
      '1 message · exited',
      '2 messages · exit 3',
      '2 messages · SIGKILL',
      '2 messages · closed',
      '2 messages · running',
      '2 messages · running',
      '2 messages · running',
    ]);
    expect([...container.querySelectorAll('.dot')].map((dot) => dot.className)).toEqual([
      'dot dot-live',
      'dot dot-idle',
      'dot dot-error',
      'dot dot-error',
      'dot dot-idle',
      'dot dot-live',
      'dot dot-live',
      'dot dot-live',
    ]);
    expect([...container.querySelectorAll('.session-tag')].map((tag) => tag.textContent)).toEqual(['http', 'sse', 'mock server', 'replay of #1']);
    expect(screen.getByText('http://x/mcp')).toBeTruthy();
    expect(container.querySelector('.is-selected')!.getAttribute('title')).toBe('node server.js\n/work');
    expect(screen.queryByText('Show older sessions')).toBeNull();

    fireEvent.click(screen.getByText('All sessions'));
    fireEvent.click(container.querySelectorAll('.session')[2]!);
    expect(onSelect.mock.calls).toEqual([[null], [2]]);
  });

  it('offers older sessions, and explains an empty list', () => {
    const onShowOlder = vi.fn();
    const { container } = render(<SessionList sessions={[]} selected={null} onSelect={() => {}} more onShowOlder={onShowOlder} />);
    fireEvent.click(screen.getByText('Show older sessions'));
    expect(onShowOlder).toHaveBeenCalledOnce();
    expect(container.querySelector('.is-selected')!.textContent).toContain('All sessions0 messages');
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
  });
});
