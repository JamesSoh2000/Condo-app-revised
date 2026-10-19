// @vitest-environment jsdom
/**
 * P3-06: `useUpload`, `FileUpload` and `PrivateImage`. Each `describe` names the criterion it proves
 * (docs/tickets/P3-06-frontend-upload-component.md). `fetch` and `XMLHttpRequest` are stubbed; the real
 * browser and S3 emulator are covered by the stack transcript in the PR.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { deniedKey } from '@/app/buildingDenial';
import { createQueryClient } from '@/app/queryClient';
import { FileUpload } from '@/features/files/FileUpload';
import { PrivateImage } from '@/features/files/PrivateImage';
import { BIRCH, MAPLE, calls, json, problem, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

const building = vi.hoisted(() => ({ id: '01929a4e-0000-7000-8000-00000000a001' }));
vi.mock('@/app/BuildingProvider', () => ({ useBuildingId: () => building.id }));

// Criterion 2's "bypassed in devtools": the client check answers "fine" for everything.
const bypass = vi.hoisted(() => ({ on: false }));
vi.mock('@/features/files/purposes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/files/purposes')>();
  return { ...actual, checkFile: (...args: Parameters<typeof actual.checkFile>) => (bypass.on ? null : actual.checkFile(...args)) };
});

type UploadOut = components['schemas']['FileUploadOut'];
type FileOut = components['schemas']['FileOut'];

const MiB = 1024 * 1024;
const S3_URL = 'http://localhost:4566/condo-app-dev-files';
const FILE_A = '01929a4e-0000-7000-8000-0000000f0001';
const FILE_B = '01929a4e-0000-7000-8000-0000000f0002';
const files = (b: { id: string } = MAPLE) => `/api/buildings/${b.id}/files`;

/** A test double for the browser's XHR: records each request; the test drives its events. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  method = '';
  url = '';
  body: FormData | null = null;
  status = 0;
  aborted = false;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
    FakeXHR.instances.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    act(() => this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent));
  }
  respond(status: number) {
    this.status = status;
    act(() => this.onload?.());
  }
  fail() {
    act(() => this.onerror?.());
  }
}

const lastXhr = () => FakeXHR.instances.at(-1)!;

function uploadOut(fileId: string, expiresInMs = 5 * 60_000): UploadOut {
  return {
    file_id: fileId,
    upload: { url: S3_URL, fields: { key: `b/x/package_photo/${fileId}`, policy: 'p', 'Content-Type': 'image/jpeg' } },
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

function fileOut(fileId: string): FileOut {
  return {
    id: fileId,
    purpose: 'package_photo',
    status: 'ready',
    content_type: 'image/jpeg',
    size_bytes: 2 * MiB,
    original_name: 'parcel.jpg',
    created_at: '2026-10-19T12:00:00Z',
  };
}

function jpeg(size = 2 * MiB, name = 'parcel.jpg', type = 'image/jpeg'): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** A server that creates FILE_A, then FILE_B, … and completes any of them. */
function uploadServer(extra: Record<string, Handler> = {}, b: { id: string } = MAPLE) {
  const ids = [FILE_A, FILE_B];
  return stubApi({
    [`POST ${files(b)}`]: () => json(uploadOut(ids.shift()!), 201),
    [`POST ${files(b)}/${FILE_A}/complete`]: () => json(fileOut(FILE_A)),
    [`POST ${files(b)}/${FILE_B}/complete`]: () => json(fileOut(FILE_B)),
    ...extra,
  });
}

/** The JSON body of the `index`th request. */
async function bodyOf(fetchMock: ReturnType<typeof stubApi>, index = 0): Promise<Record<string, unknown>> {
  return (await fetchMock.mock.calls[index][0].clone().json()) as Record<string, unknown>;
}

function wrap(node: ReactNode) {
  const queryClient = createQueryClient({ retryDelay: 0 });
  const withClient = (child: ReactNode) => <QueryClientProvider client={queryClient}>{child}</QueryClientProvider>;
  const view = render(withClient(node));
  return { queryClient, unmount: view.unmount, rerender: (child: ReactNode) => view.rerender(withClient(child)) };
}

function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  FakeXHR.instances = [];
  building.id = MAPLE.id;
  bypass.on = false;
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('criterion 1: progress, ready, onUploaded once', () => {
  it('posts the form fields then the file to S3, shows progress, completes and reports the file id', async () => {
    const fetchMock = uploadServer();
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);

    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    const xhr = lastXhr();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(S3_URL);
    // The policy fields first, the file last, as S3 requires.
    expect([...xhr.body!.keys()]).toEqual(['key', 'policy', 'Content-Type', 'file']);
    expect(await bodyOf(fetchMock)).toEqual({ purpose: 'package_photo', filename: 'parcel.jpg', content_type: 'image/jpeg', size_bytes: 2 * MiB });

    xhr.progress(MiB, 2 * MiB);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    xhr.respond(204);

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/uploaded/i));
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledWith(FILE_A);
    expect(calls(fetchMock)).toEqual([`POST ${files()}`, `POST ${files()}/${FILE_A}/complete`]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a preview of the chosen image', async () => {
    uploadServer();
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    choose(jpeg());
    expect((await screen.findByRole('img', { name: /preview of parcel.jpg/i })).getAttribute('src')).toBe('blob:preview');
  });
});

describe('criterion 2: client-side checks, and the server detail when bypassed', () => {
  it('refuses a 15 MiB image before any request', async () => {
    const fetchMock = uploadServer();
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    choose(jpeg(15 * MiB));
    expect((await screen.findByRole('alert')).textContent).toMatch(/10 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('refuses a type the purpose does not accept before any request', async () => {
    const fetchMock = uploadServer();
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    choose(jpeg(MiB, 'notice.pdf', 'application/pdf'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/JPEG, PNG, WebP or HEIC/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a narrower maxBytes prop applies, a wider one does not', async () => {
    const fetchMock = uploadServer();
    wrap(<FileUpload purpose="package_photo" maxBytes={1 * MiB} onUploaded={() => {}} />);
    choose(jpeg(2 * MiB));
    expect((await screen.findByRole('alert')).textContent).toMatch(/1 MB/);
    cleanup();
    wrap(<FileUpload purpose="package_photo" maxBytes={50 * MiB} onUploaded={() => {}} />);
    choose(jpeg(15 * MiB));
    expect((await screen.findByRole('alert')).textContent).toMatch(/10 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a HEIC file with no browser type is recognised by its extension', async () => {
    const fetchMock = uploadServer();
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    choose(jpeg(MiB, 'IMG_0001.HEIC', ''));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((await bodyOf(fetchMock)).content_type).toBe('image/heic');
  });

  it("shows the server's detail when the server refuses the file", async () => {
    const onUploaded = vi.fn();
    uploadServer({
      [`POST ${files()}`]: () =>
        json({ type: 'about:blank', title: 'Unprocessable', status: 422, code: 'file_too_large', detail: 'A package_photo may be at most 10485760 bytes.' }, 422),
    });
    bypass.on = true;
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg(15 * MiB));
    expect((await screen.findByRole('alert')).textContent).toMatch('A package_photo may be at most 10485760 bytes.');
    expect(FakeXHR.instances).toHaveLength(0);
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe('criterion 3: retry after a network drop', () => {
  it('retries with the same file while the form is valid', async () => {
    const fetchMock = uploadServer();
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().progress(MiB / 2, 2 * MiB);
    lastXhr().fail();
    expect((await screen.findByRole('alert')).textContent).toMatch(/connection/i);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    lastXhr().respond(204);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(FILE_A));
    expect(calls(fetchMock)).toEqual([`POST ${files()}`, `POST ${files()}/${FILE_A}/complete`]);
  });

  it('starts again from POST /files once the form has expired', async () => {
    const fetchMock = uploadServer({ [`POST ${files()}`]: (() => {
      const outs = [uploadOut(FILE_A, 1_000), uploadOut(FILE_B)];
      return () => json(outs.shift()!, 201);
    })() });
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().fail();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    lastXhr().respond(204);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(FILE_B));
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(calls(fetchMock)).toEqual([`POST ${files()}`, `POST ${files()}`, `POST ${files()}/${FILE_B}/complete`]);
  });

  it('starts again from POST /files when S3 refused the form', async () => {
    const fetchMock = uploadServer();
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().respond(403);
    expect((await screen.findByRole('alert')).textContent).toMatch(/storage service refused/i);
    expect(onUploaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    lastXhr().respond(204);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(FILE_B));
    expect(calls(fetchMock)).toEqual([`POST ${files()}`, `POST ${files()}`, `POST ${files()}/${FILE_B}/complete`]);
  });

  it('retries only complete when S3 already has the file', async () => {
    let attempts = 0;
    const fetchMock = uploadServer({
      [`POST ${files()}/${FILE_A}/complete`]: () => (++attempts === 1 ? problem(503, 'unavailable') : json(fileOut(FILE_A))),
    });
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().respond(204);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(FILE_A));
    expect(FakeXHR.instances).toHaveLength(1);
    expect(calls(fetchMock)).toEqual([`POST ${files()}`, `POST ${files()}/${FILE_A}/complete`, `POST ${files()}/${FILE_A}/complete`]);
  });
});

describe('criterion 4: PrivateImage renders and refreshes its URL before expiry', () => {
  it('renders the presigned URL with its alt text, then swaps it before expiry without the skeleton', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const urls = ['https://s3.test/one', 'https://s3.test/two'];
    const fetchMock = stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        json({ url: urls.shift()!, expires_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel on the desk" />);
    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
    const img = await screen.findByRole('img', { name: 'Parcel on the desk' });
    expect(img.getAttribute('src')).toBe('https://s3.test/one');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(calls(fetchMock)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await waitFor(() => expect(screen.getByRole('img', { name: 'Parcel on the desk' }).getAttribute('src')).toBe('https://s3.test/two'));
    expect(calls(fetchMock)).toHaveLength(2);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('asks again on remount once the cached URL is near its expiry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        json({ url: 'https://s3.test/one', expires_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    const { rerender } = wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    await screen.findByRole('img', { name: 'Parcel' });
    rerender(<span />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(calls(fetchMock)).toHaveLength(1);
    rerender(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    await waitFor(() => expect(calls(fetchMock)).toHaveLength(2));
  });
  it('a cached URL with time left stays fresh on remount (review round 1, F4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        json({ url: 'https://s3.test/one', expires_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    const { rerender } = wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    await screen.findByRole('img', { name: 'Parcel' });
    rerender(<span />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    rerender(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // ~30 s left, the margin is 10 s: still fresh.
    expect(calls(fetchMock)).toHaveLength(1);
  });
});

describe('criterion 5: PrivateImage when the file cannot be shown', () => {
  it('shows a neutral unavailable state and no image for a 404', async () => {
    const fetchMock = stubApi({ [`GET ${files()}/${FILE_A}/download-url`]: () => problem(404, 'file_not_found') });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    expect(await screen.findByText(/image unavailable/i)).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Parcel' })).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(calls(fetchMock)).toHaveLength(1);
  });

  it('fetches one new URL after an image load error, then gives up', async () => {
    let n = 0;
    const fetchMock = stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        json({ url: `https://s3.test/${++n}`, expires_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    fireEvent.error(await screen.findByRole('img', { name: 'Parcel' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Parcel' }).getAttribute('src')).toBe('https://s3.test/2'));
    fireEvent.error(screen.getByRole('img', { name: 'Parcel' }));
    expect(await screen.findByText(/image unavailable/i)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(calls(fetchMock)).toHaveLength(2);
  });

  it('offers a retry for a server or network error', async () => {
    let n = 0;
    stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        ++n <= 3 ? problem(503, 'unavailable') : json({ url: 'https://s3.test/ok', expires_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    expect(await screen.findByText(/couldn.t load the image/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect((await screen.findByRole('img', { name: 'Parcel' })).getAttribute('src')).toBe('https://s3.test/ok');
  });

  it("a building_not_found marks the building denied (key ['b', id, 'files', …])", async () => {
    stubApi({ [`GET ${files()}/${FILE_A}/download-url`]: () => problem(404, 'building_not_found') });
    const { queryClient } = wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    await screen.findByText(/image unavailable/i);
    expect(queryClient.getQueryData(deniedKey(MAPLE.id))).toEqual(expect.any(Number));
  });
  it('a cached image whose refresh answers 404 shows unavailable and stops polling (review round 1, F2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const fetchMock = stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        ++n === 1 ? json({ url: 'https://s3.test/one', expires_at: new Date(Date.now() + 60_000).toISOString() }) : problem(404, 'file_not_found'),
    });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    await screen.findByRole('img', { name: 'Parcel' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_100);
    });
    expect(screen.getByText('Image unavailable')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    const afterDenial = calls(fetchMock).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(calls(fetchMock)).toHaveLength(afterDenial);
  });

  it('an image error whose new URL request fails shows the error state, not the broken image (review round 1, F1)', async () => {
    let n = 0;
    const fetchMock = stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        ++n === 1 ? json({ url: 'https://s3.test/one', expires_at: new Date(Date.now() + 60_000).toISOString() }) : problem(503, 'unavailable'),
    });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    fireEvent.error(await screen.findByRole('img', { name: 'Parcel' }));
    // The original request, then the new URL's request and its two retries.
    await waitFor(() => expect(calls(fetchMock)).toHaveLength(4));
    expect(await screen.findByText(/couldn.t load the image/i)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('after F1, Retry fetches a new URL and shows the image again', async () => {
    let n = 0;
    stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        ++n === 1 || n === 5
          ? json({ url: `https://s3.test/${n}`, expires_at: new Date(Date.now() + 60_000).toISOString() })
          : problem(503, 'unavailable'),
    });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    fireEvent.error(await screen.findByRole('img', { name: 'Parcel' }));
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Parcel' }).getAttribute('src')).toBe('https://s3.test/5'));
  });

  it('an image error whose new URL request is a 404 shows unavailable', async () => {
    let n = 0;
    stubApi({
      [`GET ${files()}/${FILE_A}/download-url`]: () =>
        ++n === 1 ? json({ url: 'https://s3.test/one', expires_at: new Date(Date.now() + 60_000).toISOString() }) : problem(404, 'file_not_found'),
    });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    fireEvent.error(await screen.findByRole('img', { name: 'Parcel' }));
    expect(await screen.findByText('Image unavailable')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('after a 404, returning to the tab does not ask again', async () => {
    const fetchMock = stubApi({ [`GET ${files()}/${FILE_A}/download-url`]: () => problem(404, 'file_not_found') });
    wrap(<PrivateImage fileId={FILE_A} alt="Parcel" />);
    await screen.findByText('Image unavailable');
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {});
    expect(calls(fetchMock)).toHaveLength(1);
  });
});

describe('criterion 6: keyboard and announcements', () => {
  it('the chooser is a button that opens the file picker; status is announced politely', () => {
    uploadServer();
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    const button = screen.getByRole('button', { name: /choose file/i });
    expect(button.tagName).toBe('BUTTON');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button); // what Enter on a focused <button> does
    expect(click).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('passes accept and capture to the input', () => {
    wrap(<FileUpload purpose="package_photo" capture="environment" onUploaded={() => {}} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.getAttribute('accept')).toBe('image/jpeg,image/png,image/webp,image/heic,.heic');
    expect(input.getAttribute('capture')).toBe('environment');
  });

  it('a file dropped on the zone is uploaded', async () => {
    const fetchMock = uploadServer();
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files: [jpeg()] } });
    await waitFor(() => expect(calls(fetchMock)).toEqual([`POST ${files()}`]));
  });
});

describe('criterion 7: cancel and unmount abort the upload', () => {
  it('cancel aborts the XHR, never completes, never reports', async () => {
    const fetchMock = uploadServer();
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(lastXhr().aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls(fetchMock)).toEqual([`POST ${files()}`]);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('cancel while POST /files is in flight sends no XHR', async () => {
    let release!: () => void;
    const fetchMock = uploadServer({
      [`POST ${files()}`]: () => new Promise<Response>((resolve) => (release = () => resolve(json(uploadOut(FILE_A), 201)))),
    });
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    choose(jpeg());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it('unmounting aborts the XHR and never completes', async () => {
    const fetchMock = uploadServer();
    const onUploaded = vi.fn();
    const { unmount } = wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    const xhr = lastXhr();
    unmount();
    expect(xhr.aborted).toBe(true);
    xhr.respond(204); // a late answer from the aborted request changes nothing
    await act(async () => {});
    expect(calls(fetchMock)).toEqual([`POST ${files()}`]);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('a building switch aborts the upload started in the old building', async () => {
    const fetchMock = uploadServer();
    const onUploaded = vi.fn();
    const { rerender } = wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    building.id = BIRCH.id;
    rerender(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    expect(lastXhr().aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    expect(calls(fetchMock)).toEqual([`POST ${files()}`]);
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe('criterion 8: storage or completion failures', () => {
  it('a 409 from complete is an error with the server detail and no onUploaded', async () => {
    const onUploaded = vi.fn();
    uploadServer({
      [`POST ${files()}/${FILE_A}/complete`]: () =>
        json({ type: 'about:blank', title: 'Conflict', status: 409, code: 'upload_incomplete', detail: 'Nothing has been uploaded for this file yet.' }, 409),
    });
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().respond(204);
    expect((await screen.findByRole('alert')).textContent).toMatch('Nothing has been uploaded for this file yet.');
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('a 409 from complete is retried with a new S3 POST, not only complete', async () => {
    let attempts = 0;
    const onUploaded = vi.fn();
    uploadServer({
      [`POST ${files()}/${FILE_A}/complete`]: () =>
        ++attempts === 1 ? problem(409, 'upload_incomplete') : json(fileOut(FILE_A)),
    });
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().respond(204);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    lastXhr().respond(204);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(FILE_A));
  });

  it("a building_not_found from POST /files marks the building denied", async () => {
    uploadServer({ [`POST ${files()}`]: () => problem(404, 'building_not_found') });
    const { queryClient } = wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    choose(jpeg());
    await screen.findByRole('alert');
    expect(queryClient.getQueryData(deniedKey(MAPLE.id))).toEqual(expect.any(Number));
  });
  it('a 422 from complete is an error with the server detail and no onUploaded', async () => {
    const onUploaded = vi.fn();
    uploadServer({
      [`POST ${files()}/${FILE_A}/complete`]: () =>
        json({ type: 'about:blank', title: 'Unprocessable', status: 422, code: 'file_type_mismatch', detail: "The uploaded file's content is not the declared type." }, 422),
    });
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().respond(204);
    expect((await screen.findByRole('alert')).textContent).toMatch("The uploaded file's content is not the declared type.");
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe('criterion 9: a second file', () => {
  it('replaces the previous error and preview, and the chooser is disabled while uploading', async () => {
    uploadServer();
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg(15 * MiB));
    await screen.findByRole('alert');

    choose(jpeg(MiB, 'second.jpg'));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('img', { name: /preview of second.jpg/i })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /choose file/i }).disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);

    lastXhr().respond(204);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(FILE_A));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /choose file/i }).disabled).toBe(false);
  });

  it('a dropped file is ignored while an upload runs', async () => {
    const fetchMock = uploadServer();
    wrap(<FileUpload purpose="package_photo" onUploaded={() => {}} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files: [jpeg(MiB, 'other.jpg')] } });
    await act(async () => {});
    expect(calls(fetchMock)).toEqual([`POST ${files()}`]);
    expect(FakeXHR.instances).toHaveLength(1);
  });

  it('a second file starts its progress at 0, while its POST /files is still in flight (review round 1, F3)', async () => {
    let creates = 0;
    uploadServer({
      [`POST ${files()}`]: () => (++creates === 1 ? json(uploadOut(FILE_A), 201) : new Promise<Response>(() => {})),
    });
    const onUploaded = vi.fn();
    wrap(<FileUpload purpose="package_photo" onUploaded={onUploaded} />);
    choose(jpeg());
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    lastXhr().progress(1, 1);
    lastXhr().respond(204);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(FILE_A));
    choose(jpeg(MiB, 'second.jpg'));
    await waitFor(() => expect(creates).toBe(2));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });
});
