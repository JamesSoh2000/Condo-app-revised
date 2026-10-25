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
const WITH_PDF = notice(1, { title: 'AGM minutes', attachment_file_id: FILE_ID, attachment_content_type: 'application/pdf' });

let urls = 0;
const fresh: Handler = () => {
  urls += 1;
  return json({ url: `https://s3.test/bucket/${KEY}?X-Amz-Signature=${urls}`, expires_at: '2099-01-01T00:00:00Z' });
};

/** `window.location`, with `assign` recorded: S3 serves a PDF as an attachment, so assigning it downloads (D5). */
function fakeLocation() {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  const open = vi.spyOn(window, 'open');
  return { assign, open };
}

async function attachmentButton() {
  const dialog = await screen.findByRole('dialog', { name: 'AGM minutes' });
  return within(dialog).getByRole('button', { name: 'Download attachment (PDF)' });
}

describe('the attachment (criterion 6)', () => {
  it('asks a fresh URL on each click and downloads it in place, opening no tab', async () => {
    urls = 0;
    const fetchMock = stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { assign, open } = fakeLocation();
    renderApp([`/notices/${WITH_PDF.id}`]);

    const button = await attachmentButton();
    // Nothing is asked before the click.
    expect(calls(fetchMock)).not.toContain(`GET ${DOWNLOAD}`);
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('X-Amz-Signature=1')));

    fireEvent.click(await attachmentButton());
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith(expect.stringContaining('X-Amz-Signature=2')));
    expect(calls(fetchMock).filter((call) => call === `GET ${DOWNLOAD}`)).toHaveLength(2);
    expect(open).not.toHaveBeenCalled();
    // The notice stays open.
    expect(screen.getByRole('dialog', { name: 'AGM minutes' })).toBeTruthy();
  });

  it('never puts the URL, an S3 key or an attachment_url in the page', async () => {
    urls = 0;
    stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { assign } = fakeLocation();
    renderApp([`/notices/${WITH_PDF.id}`]);
    fireEvent.click(await attachmentButton());
    await waitFor(() => expect(assign).toHaveBeenCalled());

    const html = document.body.innerHTML;
    expect(html).not.toContain('s3.test');
    expect(html).not.toContain(KEY);
    expect(html).not.toContain('attachment_url');
    expect(document.querySelector(`a[href*="${FILE_ID}"]`)).toBeNull();
  });

  it.each([
    ['a 404 file_not_found', () => problem(404, 'file_not_found'), 'The attachment is not available.'],
    ['a 500', () => problem(500, 'internal_error'), 'Could not open the attachment, try again.'],
    ['a 429', () => problem(429, 'rate_limited', { 'Retry-After': '30' }), undefined],
  ])('shows a message on %s and goes nowhere', async (_, answer, message) => {
    stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: answer }));
    const { assign } = fakeLocation();
    renderApp([`/notices/${WITH_PDF.id}`]);
    fireEvent.click(await attachmentButton());

    const dialog = screen.getByRole('dialog', { name: 'AGM minutes' });
    const alert = await within(dialog).findByRole('alert');
    if (message) expect(alert.textContent).toBe(message);
    else expect(alert.textContent).toMatch(/try again/i);
    expect(assign).not.toHaveBeenCalled();
    // A file 404 isn't the notice's: the notice stays, and the button can be pressed again.
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Download attachment (PDF)' }).disabled).toBe(false);
  });

  it('sends one request for a double click', async () => {
    urls = 0;
    const fetchMock = stubApi(noticeMember({ notices: [WITH_PDF] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { assign } = fakeLocation();
    renderApp([`/notices/${WITH_PDF.id}`]);
    const button = await attachmentButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(calls(fetchMock).filter((call) => call === `GET ${DOWNLOAD}`)).toHaveLength(1);
  });

  it('a notice without an attachment has no button', async () => {
    stubApi(noticeMember({ notices: [notice(2, { title: 'AGM minutes' })] }));
    renderApp([`/notices/${notice(2).id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'AGM minutes' });
    expect(within(dialog).queryByRole('button', { name: /attachment/ })).toBeNull();
  });

  it('shows an image attachment inline through a download URL, with no download button (review round 1, Codex F1)', async () => {
    urls = 0;
    const plan = notice(3, { title: 'Floor plan', attachment_file_id: FILE_ID, attachment_content_type: 'image/png' });
    stubApi(noticeMember({ notices: [plan] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { assign } = fakeLocation();
    renderApp([`/notices/${plan.id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Floor plan' });
    const image = await within(dialog).findByRole('img', { name: 'Attachment: Floor plan' });
    expect(image.getAttribute('src')).toMatch(/^https:\/\/s3.test\/.*X-Amz-Signature=\d+$/);
    expect(within(dialog).queryByRole('button', { name: /attachment/i })).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it('an image the member may not have shows "Image unavailable", not a broken image', async () => {
    const plan = notice(3, { title: 'Floor plan', attachment_file_id: FILE_ID, attachment_content_type: 'image/jpeg' });
    stubApi(noticeMember({ notices: [plan] }, { [`GET ${DOWNLOAD}`]: () => problem(404, 'file_not_found') }));
    renderApp([`/notices/${plan.id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Floor plan' });
    expect(await within(dialog).findByText('Image unavailable')).toBeTruthy();
    expect(within(dialog).queryByRole('img')).toBeNull();
  });

  it('an attachment of unknown type gets the in-place download, labelled without a type', async () => {
    urls = 0;
    const odd = notice(4, { title: 'AGM minutes', attachment_file_id: FILE_ID, attachment_content_type: null });
    stubApi(noticeMember({ notices: [odd] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { assign } = fakeLocation();
    renderApp([`/notices/${odd.id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'AGM minutes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download attachment' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('X-Amz-Signature=1')));
  });

  it('a HEIC attachment, which browsers can’t show, gets the download, not an image', async () => {
    urls = 0;
    const photo = notice(5, { title: 'Lobby photo', attachment_file_id: FILE_ID, attachment_content_type: 'image/heic' });
    stubApi(noticeMember({ notices: [photo] }, { [`GET ${DOWNLOAD}`]: fresh }));
    const { assign } = fakeLocation();
    renderApp([`/notices/${photo.id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Lobby photo' });
    expect(within(dialog).queryByRole('img')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download attachment' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('X-Amz-Signature=1')));
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])('shows %s inline', async (type) => {
    const plan = notice(3, { title: 'Floor plan', attachment_file_id: FILE_ID, attachment_content_type: type });
    stubApi(noticeMember({ notices: [plan] }, { [`GET ${DOWNLOAD}`]: fresh }));
    renderApp([`/notices/${plan.id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Floor plan' });
    expect(await within(dialog).findByRole('img', { name: 'Attachment: Floor plan' })).toBeTruthy();
  });
});
