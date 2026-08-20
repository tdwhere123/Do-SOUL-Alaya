import { computeDissipativeEdgeStep } from "../../flood/edge-transfer.js";

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
  return computeDissipativeEdgeStep({
    inputPotential: input.activation,
    conductance: assertDissipativeLambda(input.lambda),
    hopCost: input.hop_cost
  });
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
