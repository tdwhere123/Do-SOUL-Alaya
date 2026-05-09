import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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

function createLargeGraph() {
  const nodes = [
    { id: "hub", kind: "memory", label: "hub-memory", summary: "high-degree" },
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `leaf-${index}`,
      kind: "memory",
      label: `leaf-${index}`,
      summary: "low-degree"
    }))
  ];
  const edges = Array.from({ length: 100 }, (_, index) => ({
    id: `edge-${index}`,
    kind: "references",
    source_id: "hub",
    target_id: `leaf-${index}`
  }));
  return {
    workspace_id: "ws-1",
    nodes,
    edges,
    truncated: true,
    node_total: 742,
    edge_total: 1998
  };
}

function renderGraph() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GraphPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function domRect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({})
  } as DOMRect;
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders graph data from the daemon success envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: SAMPLE_GRAPH }), {
        status: 200
      })
    );

    const { container } = renderGraph();

    await waitFor(() => {
      expect(container.querySelector("g[data-node-id='n1']")).toBeTruthy();
    });
    expect(screen.queryByText("Graph Error")).toBeNull();
    expect(screen.getByText("3/3 nodes")).toBeTruthy();
    expect(screen.getByText("2/2 edges")).toBeTruthy();
    expect(screen.getByText("complete")).toBeTruthy();
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

  it("sets a viewBox so the simulation coord system is decoupled from CSS pixels", async () => {
    // Regression: pre-fix, the SVG had no viewBox, so a simulation centred at
    // (width/2, height/2) of an 800×600 fallback rendered into the upper-left
    // quadrant of a larger actual SVG. With viewBox + preserveAspectRatio, the
    // sim coord system stretches/letterboxes to match the actual render area.
    const { container } = renderGraph();
    await waitFor(() => container.querySelector("g[data-node-id='n1']"));
    // Select the graph SVG specifically (lucide icons render their own SVGs
    // earlier in the DOM, so a bare `svg` selector picks the Search icon).
    const svg = container.querySelector(
      "svg[data-spotlight-active]"
    ) as SVGSVGElement | null;
    expect(svg).not.toBeNull();
    const viewBox = svg!.getAttribute("viewBox");
    expect(viewBox).toBeTruthy();
    expect(viewBox).toMatch(/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/);
    expect(svg!.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  });

  it("sizes the viewBox from the graph viewport, not the SVG intrinsic fallback", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      if ((this as Element).getAttribute("data-graph-viewport") === "true") {
        return domRect(1200, 900);
      }
      return domRect(0, 0);
    });
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: SVGElement
    ) {
      if ((this as Element).matches("svg[data-spotlight-active]")) {
        return domRect(1200, 150);
      }
      return domRect(0, 0);
    });

    const { container } = renderGraph();

    await waitFor(() => container.querySelector("g[data-node-id='n1']"));
    const svg = container.querySelector(
      "svg[data-spotlight-active]"
    ) as SVGSVGElement | null;
    expect(svg?.getAttribute("viewBox")).toBe("0 0 1200 900");
  });

  it("samples large-graph labels and surfaces returned-vs-total counts", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: createLargeGraph() }), {
        status: 200
      })
    );

    const { container } = renderGraph();

    await waitFor(() => {
      expect(container.querySelector("g[data-node-id='hub']")).toBeTruthy();
    });
    const svg = container.querySelector(
      "svg[data-spotlight-active]"
    ) as SVGSVGElement | null;
    expect(svg?.getAttribute("data-large-graph")).toBe("true");
    expect(
      container.querySelector("g[data-node-id='hub']")?.getAttribute("data-label-visible")
    ).toBe("true");
    expect(
      container.querySelector("g[data-node-id='leaf-99']")?.getAttribute("data-label-visible")
    ).toBe("false");
    expect(screen.getByText("101/742 nodes")).toBeTruthy();
    expect(screen.getByText("100/1998 edges")).toBeTruthy();
    expect(screen.getByText("sampled")).toBeTruthy();
  });

  it("posts memory actions and distinguishes already-pending proposals", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(SAMPLE_GRAPH), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { proposal_id: "proposal-existing", status: "already_pending" }
          }),
          { status: 200 }
        )
      );

    const { container } = renderGraph();

    await waitFor(() => container.querySelector("g[data-node-id='n1']"));
    const node = container.querySelector("g[data-node-id='n1']") as Element;
    await act(async () => {
      fireEvent.click(node);
    });
    await userEvent.click(await screen.findByRole("button", { name: /keep/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/proposals/ws-1/memory/n1/keep",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(
      await screen.findByText("Proposal already pending. Review at Pending Proposals.")
    ).toBeTruthy();
  });
});
