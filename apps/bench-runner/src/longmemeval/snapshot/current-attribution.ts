export function assertCurrentSnapshotAttributionClaim(input: {
  readonly attribution?: { readonly status?: unknown; readonly gate_eligible?: unknown };
}): void {
  if (input.attribution?.status !== "attributed" ||
      input.attribution.gate_eligible !== true) {
    throw new Error("current recall-eval snapshot stored gate_eligible claim is false");
  }
}
