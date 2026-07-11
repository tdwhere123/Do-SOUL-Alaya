import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainLoadedMemoryRowWindow } from "../../pages/memory-browser";
import {
  SAMPLE_ROWS,
  deferred,
  jsonResponse,
  renderMemoryBrowser,
  urlOf,
  type FetchInput
} from "./memory-browser.test-support";
import { setInspectorToken, setWorkspaceId } from "../../api";

describe("MemoryBrowserPage promote-to-strictly_governed", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setInspectorToken("t");
    setWorkspaceId("ws1");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null);
  });

  it("clears an already-open evidence pointer when refresh replaces the selected row data in place", async () => {
    let offsetZeroCalls = 0;
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/pointers/ws1/ev-old")) {
        return jsonResponse({
          success: true,
          data: {
            object_id: "ev-old",
            object_kind: "evidence_capsule",
            gist: "old gist"
          }
        });
      }
      if (!url.includes("/memory-entries/ws1") || !url.includes("offset=0")) {
        return jsonResponse({}, 404);
      }
      offsetZeroCalls += 1;
      if (offsetZeroCalls === 1) {
        return jsonResponse(
          {
            success: true,
            data: [
              {
                ...SAMPLE_ROWS[0]!,
                object_id: "mem-same",
                content: "selected memory before refresh",
                evidence_refs: ["ev-old"]
              }
            ]
          },
          200,
          {
            "x-total-count": "1",
            "x-limit": "200",
            "x-offset": "0"
          }
        );
      }
      return jsonResponse(
        {
          success: true,
          data: [
            {
              ...SAMPLE_ROWS[0]!,
              object_id: "mem-same",
              content: "selected memory after refresh",
              evidence_refs: ["ev-new"]
            }
          ]
        },
        200,
        {
          "x-total-count": "1",
          "x-limit": "200",
          "x-offset": "0"
        }
      );
    });

    renderMemoryBrowser();

    fireEvent.click(await screen.findByText("selected memory before refresh"));
    fireEvent.click(screen.getByRole("button", { name: /ev-old/u }));
    expect(await screen.findByText("old gist")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect((await screen.findAllByText("selected memory after refresh")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByText("old gist")).toBeNull();
    });
  });


  it("invalidates an in-flight evidence request as soon as refresh starts", async () => {
    const pointerDeferred = deferred<Response>();
    const refreshDeferred = deferred<Response>();
    let offsetZeroCalls = 0;
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/pointers/ws1/ev-old")) {
        return await pointerDeferred.promise;
      }
      if (!url.includes("/memory-entries/ws1") || !url.includes("offset=0")) {
        return jsonResponse({}, 404);
      }
      offsetZeroCalls += 1;
      if (offsetZeroCalls === 1) {
        return jsonResponse(
          {
            success: true,
            data: [
              {
                ...SAMPLE_ROWS[0]!,
                object_id: "mem-same",
                content: "selected memory before refresh",
                evidence_refs: ["ev-old"]
              }
            ]
          },
          200,
          {
            "x-total-count": "1",
            "x-limit": "200",
            "x-offset": "0"
          }
        );
      }
      return await refreshDeferred.promise;
    });

    renderMemoryBrowser();

    fireEvent.click(await screen.findByText("selected memory before refresh"));
    fireEvent.click(screen.getByRole("button", { name: /ev-old/u }));
    expect(screen.getByText("Loading evidence capsule...")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    pointerDeferred.resolve(
      jsonResponse({
        success: true,
        data: {
          object_id: "ev-old",
          object_kind: "evidence_capsule",
          gist: "stale gist from old request"
        }
      })
    );

    await waitFor(() => {
      expect(screen.queryByText("stale gist from old request")).toBeNull();
    });

    refreshDeferred.resolve(
      jsonResponse(
        {
          success: true,
          data: [
            {
              ...SAMPLE_ROWS[0]!,
              object_id: "mem-same",
              content: "selected memory after refresh",
              evidence_refs: ["ev-new"]
            }
          ]
        },
        200,
        {
          "x-total-count": "1",
          "x-limit": "200",
          "x-offset": "0"
        }
      )
    );

    expect((await screen.findAllByText("selected memory after refresh")).length).toBeGreaterThan(0);
    expect(screen.queryByText("stale gist from old request")).toBeNull();
  });
});

describe("retainLoadedMemoryRowWindow", () => {
  it("keeps a bounded sliding window when paginated rows exceed the cap", () => {
    const previous = Array.from({ length: 4 }, (_, index) => ({
      ...SAMPLE_ROWS[0]!,
      object_id: `prev-${index}`,
      content: `prev ${index}`
    }));
    const pageRows = Array.from({ length: 3 }, (_, index) => ({
      ...SAMPLE_ROWS[0]!,
      object_id: `next-${index}`,
      content: `next ${index}`
    }));

    const retained = retainLoadedMemoryRowWindow(previous, pageRows, 5);

    expect(retained.map((row) => row.object_id)).toEqual([
      "prev-2",
      "prev-3",
      "next-0",
      "next-1",
      "next-2"
    ]);
  });
});
