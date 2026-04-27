export type InspectorAssetPath = "/" | "/index.html" | "/inspector.css" | "/inspector.js";

export interface InspectorAsset {
  readonly path: Exclude<InspectorAssetPath, "/">;
  readonly contentType: string;
  readonly body: string;
}

const inspectorHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SOUL Memory Inspector</title>
    <link rel="stylesheet" href="/inspector.css" />
  </head>
  <body>
    <div class="shell" data-soul-memory-inspector>
      <header class="topbar">
        <div>
          <p class="eyebrow">SOUL Memory</p>
          <h1>Inspector</h1>
        </div>
        <form class="search" data-search-form>
          <input data-search-input name="q" type="search" autocomplete="off" placeholder="Search memories, evidence, paths" />
          <select data-plane-filter name="plane" aria-label="Memory plane">
            <option value="all">All planes</option>
            <option value="global">Global personal</option>
            <option value="project">Project/local</option>
          </select>
          <input data-session-input name="sessionId" autocomplete="off" placeholder="Session id" />
          <input data-context-input name="contextPackId" autocomplete="off" placeholder="Context pack id" />
          <button type="submit">Load</button>
        </form>
      </header>
      <main class="layout">
        <section class="graph-region" aria-label="Memory graph">
          <canvas data-graph-canvas width="1200" height="760"></canvas>
          <div class="legend" data-legend></div>
        </section>
        <aside class="detail-region" aria-label="Selection details">
          <section>
            <h2>Details</h2>
            <div data-details class="panel-body"></div>
          </section>
          <section>
            <h2>Recall / Session</h2>
            <div data-recall class="panel-body"></div>
          </section>
          <section>
            <h2>Governance</h2>
            <textarea data-governance-reason rows="3" placeholder="Reason required for governance actions"></textarea>
            <div class="actions">
              <button data-governance-action="accept">Accept</button>
              <button data-governance-action="reject">Reject</button>
              <button data-governance-action="retire">Retire</button>
              <button data-governance-action="mark-sensitive">Mark sensitive</button>
            </div>
            <p data-governance-status class="status-line"></p>
          </section>
        </aside>
      </main>
      <footer class="timeline-region" aria-label="Audit timeline">
        <h2>Audit Timeline</h2>
        <ol data-audit-timeline></ol>
      </footer>
    </div>
    <script src="/inspector.js" type="module"></script>
  </body>
</html>
`;

const inspectorCss = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f4ef;
  color: #1e2328;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
}

button,
input,
select,
textarea {
  font: inherit;
}

button {
  border: 1px solid #263238;
  border-radius: 6px;
  background: #263238;
  color: #ffffff;
  cursor: pointer;
  min-height: 36px;
  padding: 0 12px;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

input,
select,
textarea {
  border: 1px solid #c8c0b4;
  border-radius: 6px;
  background: #ffffff;
  color: #1e2328;
  min-height: 36px;
  padding: 8px 10px;
}

textarea {
  min-width: 100%;
  resize: vertical;
}

.shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto minmax(520px, 1fr) auto;
}

.topbar {
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
  gap: 20px;
  align-items: end;
  padding: 18px 22px;
  border-bottom: 1px solid #ded7cc;
  background: #fffaf2;
}

.eyebrow {
  margin: 0 0 4px;
  color: #676055;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 0;
  font-size: 30px;
  line-height: 1;
}

h2 {
  font-size: 15px;
  margin-bottom: 10px;
}

h3 {
  font-size: 14px;
  margin-bottom: 6px;
}

.search {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 150px 140px 160px auto;
  gap: 10px;
}

.layout {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 390px);
}

.graph-region {
  position: relative;
  min-height: 520px;
  border-right: 1px solid #ded7cc;
  background: #fbf8f3;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.legend {
  position: absolute;
  left: 16px;
  bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  max-width: calc(100% - 32px);
  gap: 8px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #d8d0c3;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.88);
  padding: 5px 8px;
  font-size: 12px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.detail-region {
  overflow: auto;
  display: grid;
  gap: 14px;
  align-content: start;
  padding: 16px;
  background: #fffdf8;
}

.detail-region section {
  border-bottom: 1px solid #e8e1d6;
  padding-bottom: 14px;
}

.panel-body {
  display: grid;
  gap: 8px;
  font-size: 13px;
}

.kv {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 8px;
}

.kv span:first-child {
  color: #676055;
}

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  border-radius: 999px;
  background: #ece6dc;
  padding: 3px 7px;
  font-size: 12px;
}

.actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}

.status-line {
  margin: 8px 0 0;
  min-height: 18px;
  color: #676055;
  font-size: 12px;
}

.timeline-region {
  border-top: 1px solid #ded7cc;
  background: #fffaf2;
  padding: 14px 22px 18px;
}

.timeline-region ol {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.timeline-region li {
  border-left: 3px solid #3d6f86;
  background: #ffffff;
  padding: 8px 10px;
  min-height: 64px;
  font-size: 13px;
}

.muted {
  color: #6f675d;
}

@media (max-width: 920px) {
  .topbar,
  .layout,
  .search {
    grid-template-columns: 1fr;
  }

  .graph-region {
    min-height: 460px;
    border-right: 0;
    border-bottom: 1px solid #ded7cc;
  }
}
`;

const inspectorJs = `const defaultEndpoints = {
    getMemoryGraph: "/api/memory/graph",
    listMemories: "/api/memory/memories",
    listAuditEvents: "/api/memory/audit-events",
    listRecallExclusions: "/api/memory/recall-exclusions",
    getMemory: (memoryId) => "/api/memory/memories/" + encodeURIComponent(memoryId),
    getSessionGraph: (sessionId) => "/api/memory/sessions/" + encodeURIComponent(sessionId) + "/graph",
    getContextPack: (contextPackId) => "/api/memory/context-packs/" + encodeURIComponent(contextPackId),
    acceptMemory: (memoryId) => "/api/memory/memories/" + encodeURIComponent(memoryId) + "/accept",
    rejectMemory: (memoryId) => "/api/memory/memories/" + encodeURIComponent(memoryId) + "/reject",
    retireMemory: (memoryId) => "/api/memory/memories/" + encodeURIComponent(memoryId) + "/retire",
    markSensitive: (memoryId) => "/api/memory/memories/" + encodeURIComponent(memoryId) + "/mark-sensitive"
  };

const userConfig = window.SOUL_MEMORY_INSPECTOR_CONFIG || {};
const config = {
  ...userConfig,
  endpoints: {
    ...defaultEndpoints,
    ...(userConfig.endpoints || {})
  }
};

const colors = {
  global_memory: "#26606f",
  project_memory: "#4d7c2f",
  evidence: "#7d6633",
  path: "#8f4e27",
  decision: "#3859a8",
  constraint: "#7d4a8d",
  preference: "#2d776b",
  hazard: "#b04444",
  episode: "#5f6470",
  source: "#6f6a47",
  context_pack: "#3f6e9b",
  agent_session: "#78604d",
  governance_event: "#7c3f5d",
  conflict: "#b04444",
  unknown: "#5f6470"
};

const state = {
  graph: { nodes: [], edges: [] },
  positions: new Map(),
  selected: null,
  contextPack: null,
  recallExclusions: [],
  auditEvents: [],
  search: "",
  plane: "all"
};

const root = document.querySelector("[data-soul-memory-inspector]");
const canvas = root.querySelector("[data-graph-canvas]");
const ctx = canvas.getContext("2d");
const detailsEl = root.querySelector("[data-details]");
const recallEl = root.querySelector("[data-recall]");
const auditEl = root.querySelector("[data-audit-timeline]");
const legendEl = root.querySelector("[data-legend]");
const searchForm = root.querySelector("[data-search-form]");
const searchInput = root.querySelector("[data-search-input]");
const planeFilter = root.querySelector("[data-plane-filter]");
const sessionInput = root.querySelector("[data-session-input]");
const contextInput = root.querySelector("[data-context-input]");
const reasonInput = root.querySelector("[data-governance-reason]");
const governanceStatus = root.querySelector("[data-governance-status]");

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.entries)) return value.entries;
  if (value && Array.isArray(value.events)) return value.events;
  return [];
}

async function fetchJson(endpoint) {
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(endpoint + " returned HTTP " + response.status);
  return await response.json();
}

async function postJson(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(endpoint + " returned HTTP " + response.status);
  return await response.json().catch(() => ({}));
}

function normalizeGraph(payload) {
  const graph = payload && payload.graph ? payload.graph : payload;
  return {
    nodes: asArray(graph && graph.nodes).map((node, index) => ({
      id: String(node.id || node.memoryId || node.nodeId || "node-" + index),
      type: String(node.type || node.kind || node.nodeType || "unknown"),
      label: String(node.label || node.summary || node.content || node.id || "Untitled"),
      plane: String(node.plane || node.memoryPlane || node.scopePlane || ""),
      status: String(node.status || node.lifecycleState || node.governanceStatus || ""),
      confidence: node.confidence,
      source: node.source || node.sourceRef || null,
      evidence: node.evidence || node.evidenceRefs || [],
      recall: node.recall || node.recallReason || null,
      raw: node
    })),
    edges: asArray(graph && graph.edges).map((edge, index) => ({
      id: String(edge.id || edge.edgeId || "edge-" + index),
      source: String(edge.source || edge.from || edge.sourceId || ""),
      target: String(edge.target || edge.to || edge.targetId || ""),
      type: String(edge.type || edge.kind || "related"),
      explanation: String(edge.explanation || edge.reason || edge.summary || ""),
      raw: edge
    })).filter((edge) => edge.source && edge.target)
  };
}

function visibleNodes() {
  const query = state.search.trim().toLowerCase();
  return state.graph.nodes.filter((node) => {
    if (state.plane !== "all" && !String(node.plane).toLowerCase().includes(state.plane)) return false;
    if (!query) return true;
    return [node.id, node.type, node.label, node.plane, node.status].join(" ").toLowerCase().includes(query);
  });
}

function layoutNodes(nodes) {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(120, Math.min(width, height) * 0.34);
  state.positions.clear();
  nodes.forEach((node, index) => {
    const angle = nodes.length <= 1 ? 0 : (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    const ringOffset = (index % 3) * 34;
    state.positions.set(node.id, {
      x: centerX + Math.cos(angle) * (radius - ringOffset),
      y: centerY + Math.sin(angle) * (radius - ringOffset)
    });
  });
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawGraph() {
  resizeCanvas();
  const nodes = visibleNodes();
  const nodeIds = new Set(nodes.map((node) => node.id));
  layoutNodes(nodes);
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1.4;
  state.graph.edges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    const from = state.positions.get(edge.source);
    const to = state.positions.get(edge.target);
    if (!from || !to) return;
    ctx.strokeStyle = edge.type === "contradicts" ? "#b04444" : edge.type === "supersedes" ? "#8f4e27" : "#b7aa9c";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  });
  nodes.forEach((node) => {
    const point = state.positions.get(node.id);
    if (!point) return;
    const selected = state.selected && state.selected.id === node.id;
    const recalled = isNodeRecalled(node.id);
    ctx.beginPath();
    ctx.fillStyle = colors[node.type] || colors.unknown;
    ctx.arc(point.x, point.y, selected ? 12 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = recalled ? 4 : selected ? 3 : 1;
    ctx.strokeStyle = recalled ? "#d8a221" : selected ? "#1e2328" : "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#1e2328";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(shorten(node.label, 24), point.x, point.y + 24);
  });
}

function isNodeRecalled(nodeId) {
  const entries = asArray(state.contextPack && (state.contextPack.entries || state.contextPack.included));
  return entries.some((entry) => String(entry.memoryId || entry.id) === nodeId);
}

function shorten(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(0, max - 1) + "..." : text;
}

function renderLegend() {
  const types = [...new Set(state.graph.nodes.map((node) => node.type))].sort();
  legendEl.innerHTML = types.map((type) => (
    '<span class="legend-item"><span class="swatch" style="background:' + (colors[type] || colors.unknown) + '"></span>' +
    escapeHtml(type.replace(/_/g, " ")) + '</span>'
  )).join("");
}

function renderDetails() {
  const node = state.selected;
  if (!node) {
    detailsEl.innerHTML = '<p class="muted">Select a memory node or graph relationship.</p>';
    setGovernanceDisabled(true);
    return;
  }
  setGovernanceDisabled(false);
  const relatedEdges = state.graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  detailsEl.innerHTML = [
    kv("Id", node.id),
    kv("Type", node.type),
    kv("Plane", node.plane || "unknown"),
    kv("Status", node.status || "unknown"),
    kv("Confidence", node.confidence == null ? "not reported" : String(node.confidence)),
    '<h3>Summary</h3><p>' + escapeHtml(node.label) + '</p>',
    '<h3>Evidence</h3>' + renderList(asArray(node.evidence).map((item) => String(item.id || item.ref || item))),
    '<h3>Relations</h3>' + renderList(relatedEdges.map((edge) => edge.type + ": " + edge.source + " -> " + edge.target + (edge.explanation ? " - " + edge.explanation : "")))
  ].join("");
}

function renderRecall() {
  const entries = asArray(state.contextPack && (state.contextPack.entries || state.contextPack.included));
  const exclusions = asArray(state.contextPack && (state.contextPack.exclusions || state.contextPack.excluded)).concat(state.recallExclusions);
  recallEl.innerHTML = [
    '<h3>Context Pack</h3>',
    renderList(entries.map((entry) => {
      const id = String(entry.memoryId || entry.id || "unknown");
      const usage = entry.recommendedUsage || entry.usage || "advisory";
      const reason = entry.recallReason || entry.reason || "no reason reported";
      return id + " (" + usage + "): " + reason;
    })),
    '<h3>Excluded</h3>',
    renderList(exclusions.map((entry) => {
      const id = String(entry.memoryId || entry.id || "unknown");
      const reason = entry.exclusionReason || entry.reason || "no reason reported";
      return id + ": " + reason;
    }))
  ].join("");
}

function renderAudit() {
  const events = asArray(state.auditEvents).slice(0, 24);
  auditEl.innerHTML = events.map((event) => {
    const eventType = event.type || event.eventType || "audit.event";
    const at = event.createdAt || event.timestamp || event.time || "";
    const target = event.memoryId || event.targetId || event.resourceId || "";
    const summary = event.summary || event.reason || event.action || "";
    return '<li><strong>' + escapeHtml(eventType) + '</strong><br><span class="muted">' +
      escapeHtml([at, target].filter(Boolean).join(" / ")) + '</span><br>' + escapeHtml(summary) + '</li>';
  }).join("") || '<li class="muted">No audit events returned.</li>';
}

function kv(label, value) {
  return '<div class="kv"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value || "") + '</span></div>';
}

function renderList(items) {
  if (!items.length) return '<p class="muted">None reported.</p>';
  return '<div class="chip-list">' + items.map((item) => '<span class="chip">' + escapeHtml(item) + '</span>').join("") + '</div>';
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function setGovernanceDisabled(disabled) {
  root.querySelectorAll("[data-governance-action]").forEach((button) => {
    button.disabled = disabled;
  });
}

async function loadInspector() {
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  if (state.plane !== "all") params.set("plane", state.plane);
  const graphEndpoint = sessionInput.value.trim()
    ? config.endpoints.getSessionGraph(sessionInput.value.trim())
    : config.endpoints.getMemoryGraph + (params.toString() ? "?" + params.toString() : "");
  const [graphPayload, auditPayload, exclusionsPayload] = await Promise.all([
    fetchJson(graphEndpoint),
    fetchJson(config.endpoints.listAuditEvents).catch(() => []),
    fetchJson(config.endpoints.listRecallExclusions).catch(() => [])
  ]);
  state.graph = normalizeGraph(graphPayload);
  state.auditEvents = asArray(auditPayload);
  state.recallExclusions = asArray(exclusionsPayload);
  if (contextInput.value.trim()) {
    state.contextPack = await fetchJson(config.endpoints.getContextPack(contextInput.value.trim()));
  }
  if (state.selected && !state.graph.nodes.some((node) => node.id === state.selected.id)) {
    state.selected = null;
  }
  renderAll();
}

function renderAll() {
  renderLegend();
  renderDetails();
  renderRecall();
  renderAudit();
  drawGraph();
}

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const node of visibleNodes()) {
    const point = state.positions.get(node.id);
    if (!point) continue;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  if (nearest && nearestDistance <= 32) {
    state.selected = nearest;
    renderAll();
  }
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.search = searchInput.value;
  state.plane = planeFilter.value;
  try {
    await loadInspector();
    governanceStatus.textContent = "";
  } catch (error) {
    governanceStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

root.querySelectorAll("[data-governance-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!state.selected) return;
    const reason = reasonInput.value.trim();
    if (!reason) {
      governanceStatus.textContent = "Reason is required.";
      return;
    }
    const action = button.getAttribute("data-governance-action");
    const endpointFactory = config.endpoints[action === "mark-sensitive" ? "markSensitive" : action + "Memory"];
    try {
      await postJson(endpointFactory(state.selected.id), {
        reason,
        policy: action === "mark-sensitive" ? { sensitive: true } : undefined
      });
      governanceStatus.textContent = action + " recorded.";
      await loadInspector();
    } catch (error) {
      governanceStatus.textContent = error instanceof Error ? error.message : String(error);
    }
  });
});

window.addEventListener("resize", drawGraph);
setGovernanceDisabled(true);
loadInspector().catch((error) => {
  detailsEl.innerHTML = '<p class="muted">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>';
  renderRecall();
  renderAudit();
});
`;

export const INSPECTOR_ASSETS: Record<Exclude<InspectorAssetPath, "/">, InspectorAsset> = {
  "/index.html": {
    path: "/index.html",
    contentType: "text/html; charset=utf-8",
    body: inspectorHtml
  },
  "/inspector.css": {
    path: "/inspector.css",
    contentType: "text/css; charset=utf-8",
    body: inspectorCss
  },
  "/inspector.js": {
    path: "/inspector.js",
    contentType: "text/javascript; charset=utf-8",
    body: inspectorJs
  }
};

export function getInspectorAsset(pathname: string = "/"): InspectorAsset | undefined {
  const cleanPath = normalizeInspectorPath(pathname);
  return INSPECTOR_ASSETS[cleanPath];
}

export function listInspectorAssets(): readonly InspectorAsset[] {
  return Object.values(INSPECTOR_ASSETS);
}

function normalizeInspectorPath(pathname: string): Exclude<InspectorAssetPath, "/"> {
  const cleanPath = pathname.split(/[?#]/, 1)[0] || "/";
  if (cleanPath === "/" || cleanPath === "") return "/index.html";
  if (cleanPath === "/index.html" || cleanPath === "/inspector.css" || cleanPath === "/inspector.js") {
    return cleanPath;
  }
  return "/index.html";
}
