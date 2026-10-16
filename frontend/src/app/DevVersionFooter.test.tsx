// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from './queryClient';

// The app's client with an absolute baseUrl: Node's Request rejects the browser's relative "/api/…".
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

const { DevVersionFooter } = await import('./DevVersionFooter');

const fetchMock = vi.fn<(request: Request) => Promise<Response>>();

function renderFooter() {
  return render(
    <QueryClientProvider client={createQueryClient({ retryDelay: 0 })}>
      <DevVersionFooter />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('DevVersionFooter (criteria 6 and 9)', () => {
  it('shows the backend version from GET /api/version in dev builds', async () => {
    vi.stubEnv('DEV', true);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          service: 'condo-management-api',
          environment: 'dev',
          git_sha: 'abc1234',
          image_tag: 'local',
          build_time: 'local',
          server_time: '2026-10-16T00:00:00+00:00',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    renderFooter();

    expect(await screen.findByText(/API abc1234 \(dev\)/)).toBeTruthy();
    expect(new URL(fetchMock.mock.lastCall![0].url).pathname).toBe('/api/version');
  });

  it('says the API is unavailable when the request fails', async () => {
    vi.stubEnv('DEV', true);
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));

    renderFooter();

    expect(await screen.findByText(/API unavailable/)).toBeTruthy();
  });

  it('renders nothing and makes no request in production builds', async () => {
    vi.stubEnv('DEV', false);
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));

    const { container } = renderFooter();
    // Long enough for a query to fetch, fail and render "API unavailable" if the footer were mounted.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(container.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
