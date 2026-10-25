// @vitest-environment jsdom
/**
 * P6-02b criterion 6: a notice's attachment downloads through a URL asked at click time
 * (docs/tickets/P6-02b-urgent-banner-and-attachments.md).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAPLE, calls, json, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';
import { notice, noticeMember } from '@/test/notices';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const FILE_ID = '01929a4e-0000-7000-8000-0000000a7701';
const DOWNLOAD = `/api/buildings/${MAPLE.id}/files/${FILE_ID}/download-url`;
const KEY = `buildings/${MAPLE.id}/notice_attachment/${FILE_ID}`;
const WITH_PDF = notice(1, { title: 'AGM minutes', attachment_file_id: FILE_ID });

let urls = 0;
const fresh: Handler = () => {
  urls += 1;
  return json({ url: `https://s3.test/bucket/${KEY}?X-Amz-Signature=${urls}`, expires_at: '2099-01-01T00:00:00Z' });
};

/** A stand-in for the tab `window.open` returns. */
function fakeTab() {
  const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
  return { tab, open };
}

async function attachmentButton() {
  const dialog = await screen.findByRole('dialog', { name: 'AGM minutes' });
  return within(dialog).getByRole('button', { name: 'Download attachment (PDF)' });
}

describe('the attachment (criterion 6)', () => {
  it('asks a fresh URL on each click and opens it in the tab opened at the click', async () => {
    urls = 0;
    const fetchMock = stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { tab, open } = fakeTab();
    renderApp([`/notices/${WITH_PDF.id}`]);

    const button = await attachmentButton();
    // Nothing is asked before the click.
    expect(calls(fetchMock)).not.toContain(`GET ${DOWNLOAD}`);
    fireEvent.click(button);
    // Opened in the click itself, blank, so a popup blocker allows it.
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toContain('X-Amz-Signature=1'));
    expect(tab.opener).toBeNull();

    fireEvent.click(await attachmentButton());
    await waitFor(() => expect(tab.location.href).toContain('X-Amz-Signature=2'));
    expect(calls(fetchMock).filter((call) => call === `GET ${DOWNLOAD}`)).toHaveLength(2);
  });

  it('never puts the URL, an S3 key or an attachment_url in the page', async () => {
    urls = 0;
    stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { tab } = fakeTab();
    renderApp([`/notices/${WITH_PDF.id}`]);
    fireEvent.click(await attachmentButton());
    await waitFor(() => expect(tab.location.href).not.toBe(''));

    const html = document.body.innerHTML;
    expect(html).not.toContain('s3.test');
    expect(html).not.toContain(KEY);
    expect(html).not.toContain('attachment_url');
    expect(document.querySelector(`a[href*="${FILE_ID}"]`)).toBeNull();
  });

  it.each([
    ['a 404 file_not_found', () => problem(404, 'file_not_found'), 'The attachment is not available.'],
    ['a 500', () => problem(500, 'internal_error'), 'Could not open the attachment, try again.'],
  ])('closes the tab and shows a message on %s', async (_, answer, message) => {
    stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: answer }));
    const { tab } = fakeTab();
    renderApp([`/notices/${WITH_PDF.id}`]);
    fireEvent.click(await attachmentButton());

    const dialog = screen.getByRole('dialog', { name: 'AGM minutes' });
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', message);
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
    // A file 404 isn't the notice's: the notice stays.
    expect(within(dialog).getByRole('button', { name: 'Download attachment (PDF)' })).toBeTruthy();
  });

  it('navigates this tab when the browser gives no new one', async () => {
    urls = 0;
    stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: fresh }));
    vi.spyOn(window, 'open').mockImplementation(() => null);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderApp([`/notices/${WITH_PDF.id}`]);
    fireEvent.click(await attachmentButton());
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('X-Amz-Signature=1')));
  });

  it('sends one request for a double click', async () => {
    urls = 0;
    const fetchMock = stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { tab, open } = fakeTab();
    renderApp([`/notices/${WITH_PDF.id}`]);
    const button = await attachmentButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(tab.location.href).not.toBe(''));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls(fetchMock).filter((call) => call === `GET ${DOWNLOAD}`)).toHaveLength(1);
  });

  it('a notice without an attachment has no button', async () => {
    stubApi(noticeMember({ notices: [notice(2, { title: 'AGM minutes' })] }));
    renderApp([`/notices/${notice(2).id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'AGM minutes' });
    expect(within(dialog).queryByRole('button', { name: /attachment/ })).toBeNull();
  });
});
