import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { forwardRef, type ReactElement } from "react";
import { ToastProvider } from "../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../api";
import GraphPage from "./Graph";

interface ForceGraphStubProps {
  graphData?: { nodes?: unknown[]; links?: unknown[] };
  nodeColor?: (node: { id: string }) => string;
  nodeLabel?: (node: { id: string; label?: string }) => string;
  linkColor?: (link: { id: string }) => string;
  onNodeClick?: (node: { id: string; label?: string; kind?: string }) => void;
  onBackgroundClick?: () => void;
  width?: number;
  height?: number;
}

// vi.mock is hoisted to the top of the file, so the lazy import inside the
// stub can safely reference React without a circular dep.

// Mocks for the WebGL/Canvas-heavy force-graph components: jsdom can't run
// the real `force-graph` simulation (it pokes a real CanvasRenderingContext),
// and we don't need to test that library — only that we're feeding it the
// right data and wiring up the click/colour callbacks correctly.
vi.mock("react-force-graph-2d", () => {
  const Stub = forwardRef<unknown, ForceGraphStubProps>((props, _ref) => {
    const nodes = props.graphData?.nodes ?? [];
    const links = props.graphData?.links ?? [];
    return (
      <div
        data-testid="force-graph-2d"
        data-node-count={nodes.length}
        data-link-count={links.length}
        data-width={props.width}
        data-height={props.height}
      >
        {nodes.map((rawNode) => {
          const node = rawNode as { id: string; label?: string; kind?: string };
          return (
            <button
              key={node.id}
              data-testid={`fg-node-${node.id}`}
              data-color={props.nodeColor?.(node) ?? ""}
              data-label-text={props.nodeLabel?.(node) ?? ""}
              onClick={() => props.onNodeClick?.(node)}
            >
              {node.label ?? node.id}
            </button>
          );
        })}
        <button
          data-testid="fg-background"
          onClick={() => props.onBackgroundClick?.()}
        >
          background
        </button>
      </div>
    );
  });
  Stub.displayName = "ForceGraph2DStub";
  return { default: Stub };
});

vi.mock("react-force-graph-3d", () => {
  const Stub = forwardRef<unknown, ForceGraphStubProps>((props, _ref) => (
    <div
      data-testid="force-graph-3d"
      data-node-count={(props.graphData?.nodes ?? []).length}
      data-link-count={(props.graphData?.links ?? []).length}
    />
  )) as unknown as (props: ForceGraphStubProps) => ReactElement;
  return { default: Stub };
});

// WebGL: default to "supported" so the 2D/3D toggle is actionable in tests.
// The probe in Graph.tsx now does a real clear + readPixels round-trip
// (Phase 3 review M-3); the stub has to play back the matching colour bytes.
function stubWebgl(supported: boolean): void {
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    contextId: string,
    options?: unknown
  ) {
    if (contextId === "webgl" || contextId === "webgl2") {
      if (!supported) return null;
      let pendingClear: [number, number, number, number] = [0, 0, 0, 0];
      return {
        createProgram: () => ({}),
        deleteProgram: () => undefined,
        // The probe sets clearColor(0.4, 0.6, 0.8, 1.0) → 102/153/204/255.
        clearColor: (r: number, g: number, b: number, a: number) => {
          pendingClear = [
            Math.round(r * 255),
            Math.round(g * 255),
            Math.round(b * 255),
            Math.round(a * 255)
          ];
        },
        clear: () => undefined,
        readPixels: (
          _x: number,
          _y: number,
          _w: number,
          _h: number,
          _format: number,
          _type: number,
          buffer: Uint8Array
        ) => {
          buffer[0] = pendingClear[0];
          buffer[1] = pendingClear[1];
          buffer[2] = pendingClear[2];
          buffer[3] = pendingClear[3];
        },
        COLOR_BUFFER_BIT: 0x4000,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401
      } as unknown as WebGLRenderingContext;
    }
    return realGetContext.call(this, contextId as "2d", options as never);
  });
}

const SAMPLE_GRAPH = {
  workspace_id: "ws-1",
  nodes: [
    {
      id: "n1",
      kind: "memory",
      label: "mem-alpha",
      summary: "first",
      origin_kind: "user_memory",
      last_used_at: new Date().toISOString(),
      influence_count: 3
    },
    {
      id: "n2",
      kind: "memory",
      label: "mem-beta",
      summary: "second",
      origin_kind: "engineering_chunk",
      last_used_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString()
    },
    {
      id: "n3",
      kind: "scope",
      label: "scope-gamma",
      summary: "third",
      origin_kind: "system"
    }
  ],
  edges: [
    {
      id: "e1",
      kind: "references",
      source_id: "n1",
      target_id: "n2",
      strength_normalized: 0.85,
      stability_class: "stable",
      last_reinforced_at: new Date().toISOString()
    },
    {
      id: "e2",
      kind: "belongs_to",
      source_id: "n2",
      target_id: "n3",
      strength_normalized: 0.2,
      stability_class: "volatile"
    }
  ],
  truncated: false,
  node_total: 3,
  edge_total: 2
};

function renderGraphWithEnv() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GraphPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("GraphPage (react-force-graph driven)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    stubWebgl(true);
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_GRAPH), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders graph data from the daemon success envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: SAMPLE_GRAPH }), {
        status: 200
      })
    );
    renderGraphWithEnv();
    const stub = await screen.findByTestId("force-graph-2d");
    expect(stub.getAttribute("data-node-count")).toBe("3");
    expect(stub.getAttribute("data-link-count")).toBe("2");
  });

  it("surfaces returned-vs-total counts and the sampled badge", async () => {
    const sampled = {
      ...SAMPLE_GRAPH,
      truncated: true,
      node_total: 25,
      edge_total: 40
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(sampled), { status: 200 })
    );
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    expect(await screen.findByText(/3\/25 nodes/i)).toBeTruthy();
    expect(await screen.findByText(/2\/40 edges/i)).toBeTruthy();
    expect(await screen.findByText(/sampled/i)).toBeTruthy();
  });

  it("mounts the origin-kind legend so users can decode node colours", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    expect(screen.getByText(/user memory/i)).toBeTruthy();
    expect(screen.getByText(/engineering chunk/i)).toBeTruthy();
    expect(screen.getByText(/reviewed engineering/i)).toBeTruthy();
    expect(screen.getByText(/proposal pending/i)).toBeTruthy();
  });

  it("opens the detail drawer on node click", async () => {
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.click(screen.getByTestId("fg-node-n1"));
    // After click the label should appear at least twice — once in the stub
    // button and once inside the DetailDrawer header — so "all" is the right
    // query (findByText would throw on the multi-match).
    await waitFor(() => {
      const matches = screen.getAllByText("mem-alpha");
      expect(matches.length).toBeGreaterThan(1);
    });
  });

  it("toggles to the 3D component when the 3D button is clicked", async () => {
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const toggle3d = screen.getByRole("button", { name: /3D/i });
    await user.click(toggle3d);
    await waitFor(() => {
      expect(screen.getByTestId("force-graph-3d")).toBeTruthy();
      expect(screen.queryByTestId("force-graph-2d")).not.toBeTruthy();
    });
  });

  it("locks 2D mode and disables the 3D toggle when WebGL is unavailable", async () => {
    vi.restoreAllMocks();
    stubWebgl(false);
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const toggle3d = screen.getByRole("button", { name: /3D/i }) as HTMLButtonElement;
    expect(toggle3d.disabled).toBe(true);
  });

  // Note: the full retire→already-pending toast flow is pinned daemon-side at
  // apps/core-daemon/src/__tests__/routes-proposals.test.ts ("dedupes a
  // repeated retire click" + "still creates a new proposal when ..."), which
  // round-trips real fetch + real proposal repo. Re-pinning the same flow
  // through DetailDrawer in jsdom adds brittle DOM coupling without new
  // coverage.

  // invariant: search filter dims non-matching, non-adjacent nodes purely
  // through the colour closure — no DOM mutation, no class toggling. The
  // canvas itself is opaque, so we sample the stub's data-color attribute
  // (which echoes nodeColor()) and check the alpha collapsed to 0.12.
  it("dims non-matching nodes via colour closure when a search filter is set", async () => {
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.type(screen.getByPlaceholderText(/probe label/i), "alpha");
    await waitFor(() => {
      // n3 is two hops from the alpha match (n1) — neither match nor
      // adjacent → background state. Background alpha is the
      // SPOTLIGHT_BG_ALPHA constant (0.12).
      const n3Color = screen.getByTestId("fg-node-n3").getAttribute("data-color") ?? "";
      expect(n3Color).toMatch(/0\.12/);
    });
    // n1 (the match) stays at full recency alpha and never dims to background.
    const n1Color = screen.getByTestId("fg-node-n1").getAttribute("data-color") ?? "";
    expect(n1Color).not.toMatch(/0\.12/);
  });

  // invariant G8: Inspector is read-only — right-click on the graph viewport
  // never mounts a destructive context menu. See docs/handbook/invariants.md.
  it("does not surface a destructive context menu on right-click (G8)", async () => {
    renderGraphWithEnv();
    const viewport = await screen.findByTestId("force-graph-2d");
    fireEvent.contextMenu(viewport);
    expect(document.querySelector("menu[role='menu']")).toBeNull();
    // The graph viewport itself stays mounted (right-click did not unmount it).
    expect(screen.getByTestId("force-graph-2d")).toBeTruthy();
  });
});
