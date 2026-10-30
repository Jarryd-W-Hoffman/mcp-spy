// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExchanges } from '../exchanges';
import { session, summary } from '../test/fixtures';
import { ExchangeList } from './ExchangeList';

const sessions = new Map([[1, session()]]);

const messages = [
  summary({ id: 1, latency_ms: null }),
  summary({ id: 2, direction: 'server', kind: 'response', method: null, subject: null, request_id: 1, latency_ms: 12, tokens: 1500, mock: 'canned', size: 50 }),
  summary({ id: 3, rpc_id: '2', issues: [{ severity: 'warning', path: '/x', message: 'odd' }] }),
  summary({ id: 4, direction: 'server', kind: 'response', method: null, subject: null, request_id: 3, error: 'boom' }),
  summary({ id: 5, rpc_id: '3' }),
  summary({ id: 6, direction: 'server', kind: 'notification', method: 'notifications/message', subject: null, rpc_id: null }),
  summary({ id: 7, direction: 'stderr', kind: 'log', method: null, subject: null, rpc_id: null, preview: 'starting up' }),
  summary({ id: 8, direction: 'client', kind: 'invalid', method: null, subject: null, rpc_id: null, problem: 'not JSON', preview: '{oops' }),
  summary({ id: 9, session_id: 2, direction: 'server', kind: 'response', method: null, subject: null, rpc_id: '9' }),
  summary({ id: 10, direction: 'server', kind: 'error', method: null, subject: null, rpc_id: '10' }),
];

describe('ExchangeList', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('says when there is nothing to show', () => {
    render(<ExchangeList exchanges={[]} sessions={sessions} showSession selected={null} compareBase={null} onSelect={() => {}} />);
    expect(screen.getByText(/Nothing to show yet/)).toBeTruthy();
  });

  it('shows each kind of row, with status, latency, tokens and size', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ExchangeList exchanges={buildExchanges(messages)} sessions={sessions} showSession selected={5} compareBase={3} onSelect={onSelect} />,
    );
    const rows = [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(1).map((td) => td.textContent));
    expect(rows).toEqual([
      ['files', '→', 'tools/call read id=1mock', 'ok', '12 ms', '≈1.5k', '150 B'],
      ['files', '→', 'tools/call read id=2⚠ 1', 'boom', '', '', '200 B'],
      ['files', '→', 'tools/call read id=3', 'pending', '', '', '100 B'],
      ['files', '←', 'notifications/message', 'notify', '', '', '100 B'],
      ['files', '!', 'starting up', '', '', '', ''],
      ['files', '→', 'not JSON {oops', 'invalid', '', '', '100 B'],
      ['#2', '←', 'response id=9', 'unmatched', '', '', '100 B'],
      ['files', '←', 'response id=10', 'error', '', '', '100 B'],
    ]);
    expect([...container.querySelectorAll('.col-dir')].slice(1, 6).map((td) => td.getAttribute('title'))).toEqual([
      'Agent → server',
      'Agent → server',
      'Agent → server',
      'Server → agent',
      'Server stderr',
    ]);
    expect(container.querySelector('.is-selected')!.getAttribute('data-id')).toBe('5');
    expect(container.querySelector('.is-base')!.getAttribute('data-id')).toBe('3');
    expect(container.querySelectorAll('.is-error')).toHaveLength(3);
    expect(container.querySelector('.badge-issue')!.getAttribute('title')).toBe('/x: odd');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    fireEvent.click(screen.getByText('starting up'));
    expect(onSelect).toHaveBeenCalledWith(7);
  });

  it('hides the server column for one session, and follows new rows only while scrolled to the bottom', () => {
    const exchanges = buildExchanges(messages.slice(0, 2));
    const { container, rerender } = render(
      <ExchangeList exchanges={exchanges} sessions={sessions} showSession={false} selected={null} compareBase={null} onSelect={() => {}} />,
    );
    expect(container.querySelector('.col-session')).toBeNull();
    const list = container.querySelector('.list') as HTMLDivElement;
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });
    list.scrollTop = 200;
    fireEvent.scroll(list);
    rerender(<ExchangeList exchanges={buildExchanges(messages.slice(0, 3))} sessions={sessions} showSession={false} selected={null} compareBase={null} onSelect={() => {}} />);
    expect(list.scrollTop).toBe(200);
    list.scrollTop = 890;
    fireEvent.scroll(list);
    rerender(<ExchangeList exchanges={buildExchanges(messages.slice(0, 4))} sessions={sessions} showSession={false} selected={null} compareBase={null} onSelect={() => {}} />);
    expect(list.scrollTop).toBe(1000);
  });
});
