// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FakeEventSource, stubFetch } from './test/fixtures';

it('mounts the app into #root', async () => {
  FakeEventSource.install();
  stubFetch({ '/api/messages?tail=5000': [] });
  document.body.innerHTML = '<div id="root"></div>';
  await import('./main');
  await vi.waitFor(() => expect(screen.getByText('mcpspy')).toBeTruthy());
  expect(document.getElementById('root')!.querySelector('.app')).not.toBeNull();
});
