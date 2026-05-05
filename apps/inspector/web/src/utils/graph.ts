export interface GraphNodeShape {
  readonly id: string;
  readonly kind: string;
  readonly degree?: number;
}

export const NODE_COLOR: Record<string, string> = {
  signal: "#96AD90",
  memory: "#92A8B3",
  scope: "#C9ADA7",
  projection: "#D4AF37"
};

// Caps degree-driven size variance so a 30-degree hub does not balloon to 70px.
export function nodeRadius(d: GraphNodeShape): number {
  return 8 + Math.min(6, Math.log2((d.degree ?? 0) + 1) * 2);
}

export function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "in the future";
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 9) return `${wk}w ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(day / 365);
  return `${yr}y ago`;
}

export function extractId(endpoint: string | number | GraphNodeShape): string {
  if (typeof endpoint === "string") return endpoint;
  if (typeof endpoint === "number") return String(endpoint);
  return endpoint.id;
}
