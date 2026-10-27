// @vitest-environment jsdom
/**
 * WF-02 criterion 3: the shared `FileUpload` inside the shared `Modal` keeps focus in the dialog when each of its
 * controls disables or removes itself (the P6-02f R2 F1 case). `files.test.tsx` proves the same handoffs by reading
 * `document.activeElement`, which in jsdom is still a disabled button; these use `expectFocusKept`, which reads what
 * a browser would. `fetch` and `XMLHttpRequest` are stubbed as in `files.test.tsx`.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import type { components } from "@/api/schema";
import { createQueryClient } from "@/app/queryClient";
import { FileUpload } from "@/features/files/FileUpload";
import { Modal } from "@/features/residents/Modal";
import { expectFocusKept } from "@/test/focus";
import { MAPLE, json, stubApi } from "@/test/renderApp";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    ...actual.createApiClient({ baseUrl: "http://app.test" }),
  };
});
vi.mock("@/app/BuildingProvider", () => ({ useBuildingId: () => MAPLE.id }));

const FILE_A = "01929a4e-0000-7000-8000-0000000f0001";
const files = `/api/buildings/${MAPLE.id}/files`;

/** The browser's XHR, driven by the test. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  send() {
    FakeXHR.instances.push(this);
  }
  abort() {
    this.onabort?.();
  }
}

const lastXhr = () => FakeXHR.instances.at(-1)!;

function server() {
  const out: components["schemas"]["FileUploadOut"] = {
    file_id: FILE_A,
    upload: {
      url: "http://localhost:4566/condo-app-dev-files",
      fields: { key: `b/x/package_photo/${FILE_A}` },
    },
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const ready: components["schemas"]["FileOut"] = {
    id: FILE_A,
    purpose: "package_photo",
    status: "ready",
    content_type: "image/jpeg",
    size_bytes: 1024,
    original_name: "parcel.jpg",
    created_at: "2026-10-19T12:00:00Z",
  };
  stubApi({
    [`POST ${files}`]: () => json(out, 201),
    [`POST ${files}/${FILE_A}/complete`]: () => json(ready),
  });
}

function InDialog() {
  const dialogRef = useRef<HTMLDivElement>(null);
  return (
    <Modal
      labelledBy="attach-title"
      busy={false}
      onEscape={() => {}}
      dialogRef={dialogRef}
    >
      <h2 id="attach-title">Attach a photo</h2>
      <FileUpload purpose="package_photo" onUploaded={() => {}} />
    </Modal>
  );
}

function open() {
  render(
    <QueryClientProvider client={createQueryClient({ retryDelay: 0 })}>
      <InDialog />
    </QueryClientProvider>,
  );
}

const button = (name: RegExp) => screen.getByRole("button", { name });
const dialog = () => screen.getByRole("dialog", { name: "Attach a photo" });
const click = (element: Element) => () => {
  fireEvent.click(element);
};

function choose() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, {
    target: { files: [new File(["x"], "parcel.jpg", { type: "image/jpeg" })] },
  });
}

/** Starts an upload from a focused "Choose file", and waits for its XHR with "Cancel" focused. */
async function uploading() {
  button(/choose file/i).focus();
  choose();
  await waitFor(() => {
    if (
      FakeXHR.instances.length !== 1 ||
      document.activeElement !== button(/cancel/i)
    )
      throw new Error("not uploading yet");
  });
}

beforeEach(() => {
  FakeXHR.instances = [];
  server();
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileUpload in a Modal: focus stays in the dialog when a control disables or removes itself", () => {
  it('"Choose file", disabled by the upload it starts', async () => {
    open();
    button(/choose file/i).focus();
    await expectFocusKept(choose, {
      control: () => button(/choose file/i),
      within: dialog,
    });
  });

  it('"Cancel", removed by the cancel it sends', async () => {
    open();
    await uploading();
    await expectFocusKept(click(button(/cancel/i)), {
      control: () => button(/cancel/i),
      within: dialog,
    });
  });

  it('"Retry", removed by the retry it starts', async () => {
    open();
    await uploading();
    act(() => lastXhr().onerror?.());
    await waitFor(() => {
      if (document.activeElement !== button(/retry/i))
        throw new Error("no Retry focused yet");
    });
    await expectFocusKept(click(button(/retry/i)), {
      control: () => button(/retry/i),
      within: dialog,
    });
  });

  it('"Cancel", removed when the upload finishes (a server answer, not a click)', async () => {
    open();
    await uploading();
    await expectFocusKept(
      () => {
        lastXhr().status = 204;
        lastXhr().onload?.();
      },
      {
        control: () => button(/cancel/i),
        within: dialog,
        settle: () => screen.findByText("Uploaded parcel.jpg.").then(() => {}),
      },
    );
  });

  it('"Cancel", removed when the upload fails', async () => {
    open();
    await uploading();
    await expectFocusKept(() => lastXhr().onerror?.(), {
      control: () => button(/cancel/i),
      within: dialog,
      settle: () =>
        screen.findByRole("button", { name: /retry/i }).then(() => {}),
    });
  });
});
