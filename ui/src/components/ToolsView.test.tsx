// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolsReport } from '../../../src/types.js';
import { session, Status, stubFetch } from '../test/fixtures';
import { ToolsView } from './ToolsView';

const report = (patch: Partial<ToolsReport> = {}): ToolsReport => ({
  sessionId: 1,
  definitions: { messageId: 5, requestId: 4, total: 1200, tools: [{ name: 'small', tokens: 100 }, { name: 'big', tokens: 1000 }] },
  calls: [
    { name: 'big', calls: 3, errors: 1, avgLatency: 10, maxLatency: 20, totalTokens: 3000, maxTokens: 1500 },
    { name: 'small', calls: 1, errors: 0, avgLatency: null, maxLatency: null, totalTokens: 5, maxTokens: 5 },
  ],
  previousSessionId: 0,
  previousListMessageId: 2,
  changes: [
    { name: 'big', change: 'changed', fields: ['description'], tokenDelta: 200 },
    { name: 'gone', change: 'removed', fields: [], tokenDelta: -50 },
    { name: 'new', change: 'added', fields: [], tokenDelta: 0 },
  ],
  ...patch,
});

describe('ToolsView', () => {
  it('shows definition costs, changes and call stats, and opens the diff', async () => {
    stubFetch({ '/api/sessions/1/tools': report() });
    const onCompare = vi.fn();
    const { container } = render(<ToolsView session={session()} onCompare={onCompare} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    await screen.findByText('Tool definitions');
    expect(container.querySelector('.card-figure')!.textContent).toBe('≈1.2k tokens · 2 tools');
    expect([...container.querySelectorAll('.cost-name')].map((name) => name.textContent)).toEqual(['big', 'small']);
    expect((container.querySelectorAll('.cost-fill')[1] as HTMLElement).style.width).toBe('10%');
    expect(screen.getByText('Changes since session #0')).toBeTruthy();
    expect([...container.querySelectorAll('.change')].map((change) => change.textContent)).toEqual(['~bigdescription+200 tok', '−gone−50 tok', '+new']);
    expect([...container.querySelectorAll('tbody tr')].map((tr) => tr.textContent)).toEqual(['big3110 ms20 ms≈3.0k≈1.5k', 'small10––≈5≈5']);
    expect(container.querySelector('.is-bad')!.textContent).toBe('1');
    fireEvent.click(screen.getByText('View diff'));
    expect(onCompare).toHaveBeenCalledWith(2, 4);
  });

  it('explains missing tool lists, identical lists and no calls', async () => {
    stubFetch({
      '/api/sessions/1/tools': report({ definitions: null, calls: [], changes: [] }),
      '/api/sessions/2/tools': report({ changes: null }),
      '/api/sessions/3/tools': report({ definitions: { messageId: 5, requestId: null, total: 0, tools: [] }, changes: [{ name: 'x', change: 'added', fields: [], tokenDelta: 1 }] }),
      '/api/sessions/4/tools': report({ previousListMessageId: null }),
    });
    const { rerender } = render(<ToolsView session={session()} onCompare={() => {}} />);
    await screen.findByText('No tools/list recorded in this session.');
    expect(screen.getByText('The tool list is identical.')).toBeTruthy();
    expect(screen.getByText('No tool calls yet.')).toBeTruthy();
    rerender(<ToolsView session={session({ id: 2 })} onCompare={() => {}} />);
    await waitFor(() => expect(screen.queryByText(/Changes since/)).toBeNull());
    rerender(<ToolsView session={session({ id: 3 })} onCompare={() => {}} />);
    await screen.findByText('Changes since session #0');
    expect(screen.queryByText('View diff')).toBeNull();
    rerender(<ToolsView session={session({ id: 4 })} onCompare={() => {}} />);
    await screen.findByText('2 tools', { exact: false });
    expect(screen.queryByText('View diff')).toBeNull();
  });

  it('reports a failed load, and ignores replies for a session no longer shown', async () => {
    let answer!: (value: unknown) => void;
    stubFetch({ '/api/sessions/1/tools': new Promise((resolve) => (answer = resolve)), '/api/sessions/2/tools': new Status(500) });
    const { rerender } = render(<ToolsView session={session()} onCompare={() => {}} />);
    rerender(<ToolsView session={session({ id: 2 })} onCompare={() => {}} />);
    await screen.findByText("Couldn't load tools: HTTP 500");
    answer(report());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText('Tool definitions')).toBeNull();
  });

  it('ignores a failure for a session no longer shown', async () => {
    let fail!: (value: unknown) => void;
    stubFetch({ '/api/sessions/1/tools': new Promise((resolve) => (fail = resolve)), '/api/sessions/2/tools': report() });
    const { rerender } = render(<ToolsView session={session()} onCompare={() => {}} />);
    rerender(<ToolsView session={session({ id: 2 })} onCompare={() => {}} />);
    await screen.findByText('Tool definitions');
    fail(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText(/late/)).toBeNull();
  });
});
