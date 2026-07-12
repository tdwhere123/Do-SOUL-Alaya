import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setInspectorToken, setWorkspaceId } from "../../api";
import {
  STABILITY_DASH,
  linkDistance,
  linkStrength,
  linkWidth,
  nodeInfluenceSize
} from "../../utils/graph";
import {
  SAMPLE_GRAPH,
  createAnimationFrameDriver,
  getForceGraphMockState,
  makeLargePathGraph,
  makeRelationKindGraph,
  renderGraphWithEnv,
  stubWebgl
} from "./graph.test-support";

describe("GraphPage (react-force-graph driven)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const forceGraphMockState = getForceGraphMockState();

  beforeEach(() => {
    forceGraphMockState.reset();
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
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/graph/ws-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-Alaya-Inspector-Token": "test-token" })
      })
    );
    expect(stub.getAttribute("data-node-count")).toBe("3");
    expect(stub.getAttribute("data-link-count")).toBe("2");
  });

  it("renders no-workspace alert and never fetches when workspaceId is null", async () => {
    setWorkspaceId(null);

    renderGraphWithEnv();

    expect(await screen.findByTestId("graph-no-workspace")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The path-graph projection returns the full active path plane (never
  // sampled), so the meta footer shows rendered == topology totals and the
  // "complete" badge rather than a sampled badge.
  it("surfaces topology totals and the complete badge", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    expect(await screen.findByText(/3\/3 nodes/i)).toBeTruthy();
    expect(await screen.findByText(/2\/2 edges/i)).toBeTruthy();
    expect(await screen.findByText(/complete/i)).toBeTruthy();
  });

  // The path plane carries no origin_kind, so the legend now decodes the
  // colours actually rendered: node hue by anchor-derived kind (memory/scope)
  // and edge hue by relation_kind family. No legend entry may decode a colour
  // no node/edge uses (the retired origin-kind palette is gone from the graph).
  it("mounts the node-kind + relation-family legend reflecting the rendered colours", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");

    const nodeLegend = screen.getByTestId("graph-legend-nodes");
    expect(within(nodeLegend).getByText(/^memory$/i)).toBeTruthy();
    expect(within(nodeLegend).getByText(/^scope$/i)).toBeTruthy();

    const edgeLegend = screen.getByTestId("graph-legend-edges");
    expect(within(edgeLegend).getByText(/^supports$/i)).toBeTruthy();
    expect(within(edgeLegend).getByText(/derives from/i)).toBeTruthy();
    expect(within(edgeLegend).getByText(/associative/i)).toBeTruthy();
    expect(within(edgeLegend).getByText(/^negative$/i)).toBeTruthy();
    expect(within(edgeLegend).getByText(/^exception$/i)).toBeTruthy();

    // The retired origin-kind palette must no longer appear as a legend entry.
    expect(screen.queryByText(/engineering chunk/i)).toBeNull();
    expect(screen.queryByText(/proposal pending/i)).toBeNull();
  });

  // invariant: edge hue is keyed by relation_kind family — a positive
  // `supports` edge and a negative `contradicts` edge must NOT share a colour
  // (the monochrome regression these fixtures guard against). Sampled from the
  // stub's data-color attribute, which echoes the live linkColor() closure.
  it("colours edges by relation_kind family (positive vs negative differ)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeRelationKindGraph()), { status: 200 })
    );
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const supportsColor =
      screen.getByTestId("fg-link-e-supports").getAttribute("data-color") ?? "";
    const contradictsColor =
      screen.getByTestId("fg-link-e-contradicts").getAttribute("data-color") ?? "";
    const recallsColor =
      screen.getByTestId("fg-link-e-recalls").getAttribute("data-color") ?? "";
    // rgba prefixes differ → the per-family base hue is actually applied.
    const rgbPrefix = (c: string) => c.replace(/,\s*[\d.]+\)$/, "");
    expect(rgbPrefix(supportsColor)).not.toBe(rgbPrefix(contradictsColor));
    expect(rgbPrefix(supportsColor)).not.toBe(rgbPrefix(recallsColor));
    expect(rgbPrefix(contradictsColor)).not.toBe(rgbPrefix(recallsColor));
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
    const callsBeforeToggle = forceGraphMockState.distanceCalls.length;
    const toggle3d = screen.getByRole("button", { name: /3D/i });
    await user.click(toggle3d);
    await waitFor(() => {
      expect(screen.getByTestId("force-graph-3d")).toBeTruthy();
      expect(screen.queryByTestId("force-graph-2d")).not.toBeTruthy();
    });
    await waitFor(() => {
      expect(forceGraphMockState.distanceCalls.length).toBeGreaterThan(callsBeforeToggle);
    });
    expect(forceGraphMockState.distanceCalls.at(-1)).toEqual([
      linkDistance(0.85),
      linkDistance(0.2)
    ]);
    expect(forceGraphMockState.strengthCalls.at(-1)).toEqual([
      0.1 + 0.9 * linkStrength(0.85),
      0.1 + 0.9 * linkStrength(0.2)
    ]);
  });

  it("locks 2D mode and disables the 3D toggle when WebGL is unavailable", async () => {
    stubWebgl(false);
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const toggle3d = screen.getByRole("button", { name: /3D/i }) as HTMLButtonElement;
    expect(toggle3d.disabled).toBe(true);
    expect(screen.getByText(/3D not available in this environment/i)).toBeTruthy();
  });

  it("pins node and edge visual encodings required by the graph plan", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");

    expect(screen.getByTestId("fg-node-n1").getAttribute("data-node-val")).toBe(
      String(nodeInfluenceSize({ id: "n1", kind: "memory", influence_count: 3 }) ** 2)
    );
    expect(screen.getByTestId("fg-link-e1").getAttribute("data-width")).toBe(
      String(linkWidth(0.85))
    );
    expect(linkDistance(0.9)).toBeCloseTo(80);
    expect(linkDistance(0.1)).toBeCloseTo(240);
    expect(linkWidth(undefined, 0.9)).toBeGreaterThan(linkWidth(undefined, 0.1));
    expect(STABILITY_DASH.volatile).toEqual([4, 3]);
  });

  it("uses legacy weight as the fallback for edge strength encoding", () => {
    expect(linkStrength(undefined, 0.9)).toBe(0.9);
    expect(linkDistance(undefined, 0.9)).toBeLessThan(linkDistance(undefined, 0.1));
    expect(linkWidth(undefined, 0.9)).toBeGreaterThan(linkWidth(undefined, 0.1));
    expect(linkStrength(undefined, undefined)).toBe(0.3);
  });

  // The path plane carries degree-derived influence but no last_used_at, so the
  // hover label pins the label + influence count from the path-graph node.
  it("includes degree-derived influence in node hover labels", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const label = screen.getByTestId("fg-node-n1").getAttribute("data-label-text") ?? "";
    expect(label).toContain("mem-alpha");
    expect(label).toContain("influence: 3");
  });

  it("focuses the one-hop subgraph shortcut on double click", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    fireEvent.click(screen.getByTestId("fg-node-n1"), { detail: 1 });
    fireEvent.click(screen.getByTestId("fg-node-n1"), { detail: 2 });
    expect((screen.getByPlaceholderText(/probe label/i) as HTMLInputElement).value).toBe("n1");
  });

  it("keeps one keydown listener while shortcuts read fresh graph state", async () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
    const user = userEvent.setup();
    const { unmount } = renderGraphWithEnv();
    const searchInput = (await screen.findByPlaceholderText(/probe label/i)) as HTMLInputElement;
    const keydownAdds = () =>
      addEventListenerSpy.mock.calls.filter(([type]) => type === "keydown");
    const keydownRemoves = () =>
      removeEventListenerSpy.mock.calls.filter(([type]) => type === "keydown");

    expect(keydownAdds()).toHaveLength(1);
    expect(keydownRemoves()).toHaveLength(0);

    await user.type(searchInput, "alpha");
    await user.click(screen.getByTestId("fg-node-n1"));
    await waitFor(() => {
      expect(screen.getAllByText("mem-alpha").length).toBeGreaterThan(1);
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.getAllByText("mem-alpha")).toHaveLength(1);
    });
    expect(searchInput.value).toBe("alpha");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(searchInput.value).toBe("");
    });

    expect(keydownAdds()).toHaveLength(1);
    expect(keydownRemoves()).toHaveLength(0);

    unmount();
    expect(keydownRemoves()).toHaveLength(1);
  });

  it("uses the large-graph 3D performance gate", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeLargePathGraph()), { status: 200 })
    );
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.click(screen.getByRole("button", { name: /3D/i }));
    await screen.findByTestId("force-graph-3d");

    expect(screen.getByText(/large graph mode/i)).toBeTruthy();
    expect(screen.getByTestId("force-graph-3d").getAttribute("data-cooldown-ticks")).toBe("60");
    expect(screen.getByTestId("fg-3d-link-large-link").getAttribute("data-particles")).toBe("0");
  });

  it("clears the low-FPS warning after sustained recovered frame cadence", async () => {
    const raf = createAnimationFrameDriver();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeLargePathGraph()), { status: 200 })
    );
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.click(screen.getByRole("button", { name: /3D/i }));
    await screen.findByTestId("force-graph-3d");

    await raf.step(0);
    for (let i = 1; i <= 16; i += 1) await raf.step(i * 100);
    expect(screen.getByText(/low fps detected/i)).toBeTruthy();

    for (let i = 1; i <= 15; i += 1) await raf.step(1600 + i * 16);
    await waitFor(() => {
      expect(screen.queryByText(/low fps detected/i)).toBeNull();
    });
  }, 15000);

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

  // invariant: when the search bar parses a time expression, the daemon
  // /soul/search endpoint is called and its returned object_ids drive the
  // spotlight; a chip below the search bar shows the parsed window label
  // and the actual hit count (not the daemon's unsliced total_count).
  it("calls /api/soul/search and highlights returned ids when a time expression parses", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_GRAPH), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            delivery_id: "delivery-1",
            results: [{ object_id: "n1", relevance_score: 0.9 }],
            total_count: 1
          }
        }),
        { status: 200 }
      )
    );
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.type(screen.getByPlaceholderText(/probe label/i), "yesterday auth");
    await waitFor(() => {
      const chip = screen.getByTestId("search-time-window-chip");
      expect(chip.textContent).toMatch(/showing/i);
      expect(chip.textContent).toMatch(/1 hits/);
    });
    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([url]) =>
        typeof url === "string" && url.includes("/soul/search/ws-1")
      );
      expect(searchCall).toBeDefined();
    });
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
