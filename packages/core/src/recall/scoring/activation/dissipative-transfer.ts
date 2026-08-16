export function assertDissipativeLambda(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0 || lambda >= 1) {
    throw new Error("dissipative lambda must satisfy 0 <= lambda < 1");
  }
  return lambda;
}

export function assertDissipativeRho(rho: number): number {
  if (!Number.isFinite(rho) || rho < 0 || rho >= 1) {
    throw new Error("dissipative rho_c must satisfy 0 <= rho_c < 1");
  }
  return rho;
}

export function computeDissipativeMessage(input: Readonly<{
  readonly lambda: number;
  readonly activation: number;
  readonly hop_cost: number;
}>): number {
  const lambda = assertDissipativeLambda(input.lambda);
  if (!Number.isFinite(input.activation) || input.activation < 0) {
    throw new Error("activation must be finite and non-negative");
  }
  if (!Number.isFinite(input.hop_cost) || input.hop_cost < 0) {
    throw new Error("hop_cost must be finite and non-negative");
  }
  return Math.max(0, lambda * input.activation - input.hop_cost);
}

export function scaleOutgoingTransfers(
  messages: readonly number[],
  available: number,
  rho: number
): readonly number[] {
  const cap = assertDissipativeRho(rho) * Math.max(0, available);
  const total = messages.reduce((sum, value) => sum + value, 0);
  if (total <= cap) return messages;
  if (total <= 0) return messages.map(() => 0);
  const scale = cap / total;
  return messages.map((value) => value * scale);
}
