import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GraphPage from "./Graph";
import { ToastProvider } from "../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../api";

const SAMPLE_GRAPH = {
  workspace_id: "ws-1",
  nodes: [
    { id: "n1", kind: "memory", label: "mem-alpha", summary: "first" },
    { id: "n2", kind: "memory", label: "mem-beta", summary: "second" },
    { id: "n3", kind: "scope", label: "scope-gamma", summary: "third" }
  ],
  edges: [
    { id: "e1", kind: "references", source_id: "n1", target_id: "n2" },
    { id: "e2", kind: "belongs_to", source_id: "n2", target_id: "n3" }
  ],
  truncated: false,
  node_total: 3,
  edge_total: 2
};

function renderGraph() {
  return render(
    <ToastProvider>
      <GraphPage />
    </ToastProvider>
  );
}

describe("GraphPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_GRAPH), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
    Object.defineProperty(SVGElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 800
    });
    Object.defineProperty(SVGElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies match/adjacent/background spotlight states based on search term", async () => {
    const { container } = renderGraph();
    await waitFor(() => container.querySelector("g[data-node-id='n1']"));
    const search = screen.getByPlaceholderText(/probe label/i);
    await act(async () => {
      await userEvent.type(search, "alpha");
    });
    await waitFor(() => {
      const n1 = container.querySelector("g[data-node-id='n1']");
      expect(n1?.getAttribute("data-state")).toBe("match");
    });
    const n2 = container.querySelector("g[data-node-id='n2']");
    const n3 = container.querySelector("g[data-node-id='n3']");
    expect(n2?.getAttribute("data-state")).toBe("adjacent");
    expect(n3?.getAttribute("data-state")).toBe("background");
  });

  it("returns all nodes to match state when search is cleared", async () => {
    const { container } = renderGraph();
    await waitFor(() => container.querySelector("g[data-node-id='n1']"));
    const search = screen.getByPlaceholderText(/probe label/i);
    await act(async () => {
      await userEvent.type(search, "alpha");
    });
    await waitFor(() => {
      expect(
        container.querySelector("g[data-node-id='n3']")?.getAttribute("data-state")
      ).toBe("background");
    });
    await act(async () => {
      await userEvent.clear(search);
    });
    await waitFor(() => {
      const states = ["n1", "n2", "n3"].map((id) =>
        container.querySelector(`g[data-node-id='${id}']`)?.getAttribute("data-state")
      );
      expect(states.every((s) => s === "match")).toBe(true);
    });
  });

  it("opens detail drawer on node click and copies CLI command", async () => {
    const { container } = renderGraph();
    await waitFor(() => container.querySelector("g[data-node-id='n1']"));
    const node = container.querySelector("g[data-node-id='n1']") as Element;
    await act(async () => {
      fireEvent.click(node);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /open in cli/i })).toBeTruthy()
    );
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /open in cli/i }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("soul.open_pointer")
    );
  });

  it("ignores contextmenu (read-only graph, satisfies G8)", async () => {
    const { container } = renderGraph();
    await waitFor(() => container.querySelector("svg"));
    const svg = container.querySelector("svg") as Element;
    fireEvent.contextMenu(svg);
    // The component's onContextMenu calls preventDefault. We assert no node
    // edit drawer opens (G8): read-only graph never enters an edit affordance.
    expect(screen.queryByRole("textbox", { name: /edit/i })).toBeNull();
  });
});
