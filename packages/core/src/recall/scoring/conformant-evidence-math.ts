import { clamp01 } from "../../shared/clamp.js";

// Bounded noisy-OR de-correlation NOR_rho:
// 1 - (1 - c1*x1) * product(i>=2)(1 - (1-rho)*ci*xi).
export function noisyOrDecorrelate(
  values: readonly number[],
  confidences: readonly number[],
  rho: number
): number {
  if (values.length === 0) {
    return 0;
  }
  const weighted = (index: number): number =>
    clamp01(confidences[index] ?? 0.5) * clamp01(values[index] ?? 0);
  if (clamp01(rho) >= 1) {
    let bestWeighted = -1;
    for (let index = 0; index < values.length; index++) {
      const term = weighted(index);
      if (term > bestWeighted) {
        bestWeighted = term;
      }
    }
    return clamp01(bestWeighted);
  }
  const lambda = 1 - clamp01(rho);
  const order = values.map((_, index) => index).sort((a, b) => weighted(b) - weighted(a));
  let complement = 1;
  order.forEach((index, position) => {
    const term = clamp01(confidences[index] ?? 0.5) * clamp01(values[index] ?? 0);
    complement *= 1 - (position === 0 ? term : lambda * term);
  });
  return clamp01(1 - complement);
}
