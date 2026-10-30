// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessageDetail } from '../../../src/types.js';
import { row, Status, stubFetch } from '../test/fixtures';
import { DiffView } from './DiffView';

const call = (id: number, args: object, result: object | null): MessageDetail => {
  const request = row({ id, payload: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read', arguments: args } }) });
  const response = result && row({ id: id + 1, direction: 'server', kind: 'response', request_id: id, payload: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  return { message: request, request, response };
};

describe('DiffView', () => {
  it('diffs requests and responses, listing changes and hunks', async () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    stubFetch({
      '/api/messages/1?listing': call(1, { path: 'a', long: 'x'.repeat(60) }, { same: true }),
      '/api/messages/3?listing': call(3, { path: 'b', long: 'y'.repeat(60), extra: 1, ...many }, { same: true }),
    });
    const { container } = render(<DiffView baseId={1} targetId={3} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    await screen.findByText('Request');
    expect(screen.getByText('#1 → #3')).toBeTruthy();
    expect(screen.getByText('Identical')).toBeTruthy();
    const changes = () => [...container.querySelectorAll('.change')].map((change) => change.textContent);
    expect(changes()).toHaveLength(8);
    expect(changes()[0]).toMatch(/^~/);
    expect(changes().join('\n')).toContain(`"${'x'.repeat(38)}…`);
    fireEvent.click(screen.getByText('5 more changes'));
    expect(changes()).toHaveLength(13);
    fireEvent.click(screen.getByText('Show fewer'));
    expect(changes()).toHaveLength(8);
    expect(container.querySelector('.diff-insert .diff-sign')!.textContent).toBe('+');
    expect(container.querySelector('.diff-delete .diff-sign')!.textContent).toBe('−');
    expect(container.querySelector('.diff-equal .diff-sign')!.textContent).toBe(' ');
    expect(container.querySelector('.diff-hunk-head')!.textContent).toMatch(/^@@ −\d+ \+\d+ @@$/);
  });

  it('shows removed keys and values that are not JSON', async () => {
    stubFetch({
      '/api/messages/1?listing': call(1, { gone: 1 }, { a: 1 }),
      '/api/messages/3?listing': call(3, {}, { a: [1] }),
    });
    const { container } = render(<DiffView baseId={1} targetId={3} />);
    await screen.findByText('Request');
    expect([...container.querySelectorAll('.change-type')].map((type) => type.textContent)).toEqual(['−', '~']);
  });

  it('says which side is missing, and compares lone messages', async () => {
    const log = row({ id: 7, kind: 'log', direction: 'stderr', payload: 'hello' });
    stubFetch({
      '/api/messages/1?listing': call(1, {}, null),
      '/api/messages/3?listing': call(3, {}, { ok: 1 }),
      '/api/messages/7?listing': { message: log, request: null, response: null },
    });
    const { rerender } = render(<DiffView baseId={1} targetId={3} />);
    await screen.findByText('Missing on the base side.');
    rerender(<DiffView baseId={3} targetId={1} />);
    await screen.findByText('Missing on the compared side.');
    rerender(<DiffView baseId={7} targetId={7} />);
    await screen.findByText('Missing on the base side.');
    expect(screen.getByText('#7 → #7')).toBeTruthy();
  });

  it('reports a failed load, ignoring replies that arrive too late', async () => {
    let late!: (value: unknown) => void;
    stubFetch({
      '/api/messages/1?listing': new Promise((resolve) => (late = resolve)),
      '/api/messages/2?listing': new Status(404),
      '/api/messages/3?listing': call(3, {}, null),
    });
    const { rerender } = render(<DiffView baseId={1} targetId={3} />);
    rerender(<DiffView baseId={2} targetId={3} />);
    await screen.findByText("Couldn't load: message #2: HTTP 404");
    late(call(1, {}, null));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText('Request')).toBeNull();
    rerender(<DiffView baseId={1} targetId={2} />);
    await screen.findByText('Loading…');
  });

  it('ignores a failure that arrives too late', async () => {
    let late!: (value: unknown) => void;
    stubFetch({ '/api/messages/1?listing': new Promise((resolve) => (late = resolve)), '/api/messages/3?listing': call(3, {}, null) });
    const { rerender } = render(<DiffView baseId={1} targetId={3} />);
    rerender(<DiffView baseId={3} targetId={3} />);
    await screen.findByText('Request');
    late(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText(/late/)).toBeNull();
  });
});
