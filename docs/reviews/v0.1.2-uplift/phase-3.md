# v0.1.2 Inspector & MCP UX Uplift — Phase 3 Review

**Diff range**: `997047f..HEAD` (Phase 3 inspector visual rebuild on `react-force-graph` + visual feedback fixes + this fix-loop)
**Lenses**: Claude `reviewer` agent + Codex `codex:codex-rescue` second opinion. Live manual e2e verified by the human operator (2D/3D toggle, origin palette, dedupe summary, OrbitControls pan).
**Verdict before fix-loop**: 0 BLOCKING + 7 IMPORTANT (Claude found 6, Codex confirmed 3 + escalated 1 + added 1)
**Verdict after fix-loop**: 0 BLOCKING + 0 IMPORTANT (all 7 closed in this loop) + 3 NICE-TO-HAVE folded in (O-1, O-2, O-7) + 4 deferred opportunities (O-3, O-5, O-6, NTH-1-touch-hint)

---

## Findings (merged)

### IMPORTANT — closed in this fix-loop

#### M-1 — `now = useMemo(() => Date.now(), [data])` froze recency / 24h glow
- **Lens**: Claude I-1 (Codex did not raise — but agreed indirectly that the d3Force re-tune is correct on `[data, viewMode]`).
- **Where**: `apps/inspector/web/src/pages/Graph.tsx`
- **Impact**: A tab left open overnight kept painting the reinforced-glow halo on edges whose `last_reinforced_at` had crossed the 24h boundary hours earlier. Recency alpha drifted slower (30-day half-life) but had the same lying-about-time pattern.
- **Fix**: replaced `useMemo` with a `useState(() => Date.now())` ticking on a 60s `setInterval`, cleared on unmount. Re-renders are cheap because the spotlight closures already depend on small primitive state; no fetch is forced.
- **Status**: ✅ Fixed

#### M-3 — WebGL probe accepted contexts that draw black (WSL2 / WARP / llvmpipe)
- **Lens**: Claude I-3 + Codex confirm
- **Where**: `apps/inspector/web/src/pages/Graph.tsx` `probeWebgl`
- **Impact**: The previous `createProgram → deleteProgram` round-trip accepted any context that allocated a program, including software fallbacks that subsequently rendered an empty/black canvas. Users on WSL2 / WARP would click 3D and see nothing paint.
- **Fix**: probe now does a real draw round-trip — `gl.clearColor(0.4, 0.6, 0.8, 1.0)` → `gl.clear(COLOR_BUFFER_BIT)` → `gl.readPixels(...)` and asserts the pixel came back as the colour we set (within an sRGB drift tolerance). Software fallbacks that cannot draw are rejected; the 3D toggle disables and 2D stays locked.
- **Test stub** updated to play back the same colour bytes so test mode still enables 3D.
- **Status**: ✅ Fixed

#### M-4 — `nodeInfluenceSize` formula drifted from plan
- **Lens**: Claude I-4
- **Where**: `apps/inspector/web/src/utils/graph.ts`
- **Impact**: Plan called for `log2(influence_count + 2) * 4` (range [4, ~27] for influence 0–100). Implementation shipped as `4 + log2(influence + 1) * 2.2` (range [4, ~18.6]) — same floor but the high-end compressed by ~30%, weakening the hub-vs-leaf reading the plan called for.
- **Fix**: implementation aligned to plan formula. Inline comment records the decision.
- **Status**: ✅ Fixed

#### M-5 — Graph.test.tsx coverage gap (spotlight, G8 invariant, label sampling)
- **Lens**: Claude I-5 + Codex confirm
- **Where**: `apps/inspector/web/src/pages/Graph.test.tsx`
- **Impact**: The Phase 3 rewrite dropped from 9 → 6 test cases. Three deletions had no daemon-side or other counterpart: spotlight match/adjacent/background dimming, search-clear reset, contextmenu G8 (Inspector is read-only).
- **Fix**:
  - **spotlight pin**: new test `dims non-matching nodes via colour closure when a search filter is set` reads `data-color` from the stub buttons, asserts background nodes collapse to alpha 0.12.
  - **G8 pin**: new test `does not surface a destructive context menu on right-click (G8)` fires a contextmenu event on the graph viewport and asserts no `<menu role="menu">` mounts. Viewport stays alive.
  - **label sampling** is now a `react-force-graph` library-internal concern (it owns the simulation); we do not re-pin it.
- **Status**: ✅ Closed (8 tests now pass).

#### M-6 — `deriveDomainTagSummary` dedupe shipped with no test
- **Lens**: Claude I-6 (Codex separately verified the math is correct, no off-by-one)
- **Where**: `apps/core-daemon/src/daemon-runtime-support.ts` + `apps/core-daemon/src/__tests__/soul-graph-service.test.ts`
- **Fix**: exported `deriveDomainTagSummary`; added a new `describe` block with four cases — empty bucket → `"0 memories"`; uniform bucket of 226 same-firstLine members → `"226 memories · all: …"` and the phrase appears exactly once (the regression we are pinning); heterogeneous 5-distinct → `"+2 more variants"`; 4-distinct → singular `"+1 more variant"`.
- **Status**: ✅ Fixed

#### M-7 — Origin legend was colour-only (CVD risk)
- **Lens**: Claude O-4 (NICE-TO-HAVE) → Codex escalated to IMPORTANT
- **Where**: `apps/inspector/web/src/pages/Graph.tsx` `OriginLegend`
- **Impact**: 5 origin kinds were distinguished only by hue. Operators with deuteranopia / tritanopia could lose the user_memory (teal) ↔ reviewed_engineering_chunk (violet) split, or the proposal_pending (amber) ↔ system (wine) split, especially at low alpha. Empirical contrast spot-check: `engineering_chunk` slate `#8E9396` on paper `#FDF6E3` clears WCAG AA non-text barely (3.18:1) at full alpha; under recencyAlpha 0.3 it drops below 3:1 and becomes near-invisible.
- **Fix**: each legend swatch is now a single-letter glyph badge (U / E / R / P / S) drawn over the origin colour. Colour-blind operators have a redundant text channel; sighted operators get a glanceable identifier. Tooltip per row carries the long-form description.
- **Status**: ✅ Fixed (legend); inside-canvas glyphs deferred to opportunity (would muddy small nodes).

#### M-2 — Three.js / `react-force-graph-3d` shipped in main entry chunk
- **Lens**: Claude I-2 + Codex confirm
- **Where**: `apps/inspector/web/src/pages/Graph.tsx`
- **Impact**: 2D-only / WebGL-locked users paid the full ~1.7 MB / 450 kB-gzipped bundle on first paint, even though they could never reach 3D.
- **First attempt** (rolled back): naive `lazy(() => import("react-force-graph-3d"))` collapsed the component's type to a wider `LinkObject<NodeObject<...>>` that fought our strongly-typed `GraphNode` / `GraphLink` callbacks.
- **Final fix**: `import type ForceGraph3DType from "react-force-graph-3d"` (the type-only import evaporates at runtime), then `lazy(() => import(...)) as unknown as typeof ForceGraph3DType` preserves the static signature for every callback. The 3D branch is wrapped in `<Suspense>` with a "loading 3D engine…" fallback. Bundle splits cleanly:
  - `index-*.js` (main): **465 kB raw / 137 kB gzipped** — was 1.7 MB / 450 kB
  - `react-force-graph-3d-*.js` (lazy): 1.25 MB raw / 332 kB gzipped — fetched only on first 3D toggle click
  - 2D-only initial-paint cost down ~70%.
- **Status**: ✅ Fixed

### NICE-TO-HAVE — folded in or deferred

- **O-1**: dead `d3-drag` / `d3-force` / `d3-selection` / `d3-zoom` runtime deps and their `@types/*` siblings ✅ removed from `apps/inspector/web/package.json`. Vite manualChunks `d3` chunk also removed (it pointed at the deleted modules). Bundle composition unchanged because `react-force-graph` keeps its own d3 internals.
- **O-2**: duplicate `extractId` definition ✅ removed from `Graph.tsx`; the page now imports the single source-of-truth from `utils/graph.ts`.
- **O-5**: `STABILITY_DASH` over-broad `Record<string, …>` ✅ tightened to `Record<"stable" | "normal" | "pinned" | "volatile", …>` so a future schema addition (`consolidating`, etc.) surfaces in the compiler instead of silently falling through to "solid".
- **O-7**: WebGL `webglSupported = true` flicker ✅ fixed by lazy-init useState — probe runs synchronously before the first paint.
- **NTH-1**: 3D hint extended to cover touch — "(touch: 1-finger rotate · 2-finger pan / pinch zoom)" appended.

Two opportunities remain open and need a user decision before action — neither blocks merge:

- **O-3** (closure churn on every keystroke): for 200-node graphs the re-render cost on search is invisible; for 5k+ node workspaces it can stutter. Mitigation is a 120 ms `searchTerm` debounce. Open question: do any current workspaces approach the 5k node mark? If not, this is real-but-not-yet-felt.
- **O-6** (2D ↔ 3D toggle does not preserve node positions): both ForceGraph instances run their own simulation from random initial positions on mount. Toggling forgets layout. Mitigation is a position cache (read x/y/z from the unmounting instance, pass as initial positions on remount). Mid-effort UX polish.

### OK and pinned (verified by both lenses)

- **Spotlight encoding via colour closure fires under `nodeCanvasObjectMode === "replace"`** — `nodeCanvasObject` directly invokes `computeNodeColor(node)` for the fill, so dim-on-non-match works in 2D even though the lib does not auto-apply `nodeColor` in replace mode.
- **2D and 3D simulations are mutually exclusive** — conditional render keeps only one ForceGraph mounted; the d3Force re-tune calls `apply(fg2dRef.current); apply(fg3dRef.current)` blindly, but the unmounted ref is `undefined` so the optional-chain guard handles it. No phantom simulation.
- **3D directional-particle prop names** match the local `react-force-graph-3d` package types.
- **`deriveDomainTagSummary` dedupe math** is correct — 4 distinct labels with limit 3 reports `+1 more variant`; no off-by-one.

---

## Status

- BLOCKING: 0 open / 0 closed
- IMPORTANT: 0 open / 7 closed (M-1, M-2, M-3, M-4, M-5, M-6, M-7)
- NICE-TO-HAVE: 3 folded in (O-1, O-2, O-7) / 4 deferred (O-3, O-5, O-6, NTH-1-touch-hint)

Verification (fresh):
- `rtk pnpm build` — pass
- `rtk pnpm test` — **2253 / 2253 pass** (280 / 280 test files), including 2 new Graph.test.tsx pin tests (spotlight + G8) and 4 new soul-graph-service.test.ts cases for `deriveDomainTagSummary`.
- Manual e2e (live operator verification): 2D ↔ 3D toggle, paper background in both modes, 5-colour origin palette with letter glyphs, summary dedupe (`#codex-memory-recall-shard` collapses to `all: Codex memory recall shard`), OrbitControls pan via right-drag.

Next: Phase 3 closed (all 7 IMPORTANT findings resolved in this loop, no deferral to v0.1.3). Phase 4 (NL + time search) and Phase 5 (closeout, npm publish) remain.
