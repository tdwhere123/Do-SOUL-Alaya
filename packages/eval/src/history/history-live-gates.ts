import { readFile } from "node:fs/promises";

export async function liveGatesSidecarAllowsLatestPassing(
  sidecarPath: string,
  isNotFound: (error: unknown) => boolean
): Promise<boolean> {
  try {
    const raw = await readFile(sidecarPath, "utf8");
    return liveGatesJsonAllowsLatestPassing(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return false;
    throw error;
  }
}

function liveGatesJsonAllowsLatestPassing(sidecar: unknown): boolean {
  if (!isRecord(sidecar)) return false;
  if (sidecar.status !== "pass") return false;
  if (typeof sidecar.latest_run_id !== "string" || sidecar.latest_run_id.length === 0) {
    return false;
  }
  if (!Array.isArray(sidecar.gates) || sidecar.gates.length === 0) return false;
  return sidecar.gates.some(
    (gate) =>
      isRecord(gate) &&
      typeof gate.id === "string" &&
      gate.id.length > 0 &&
      gate.pass === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
