import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

/** Private acquisition and joint replies share the existing canonical-size / UTF-16 transport tariff.
 * This is serialization work, not another debit of the captured native execution prefix.
 */
export function chargeResearchTransport(value: unknown, meter: SourceSemanticReadBudget): number {
  const length = meter.canonicalJsonLength(value);
  chargeEncoding(length, meter);
  return length;
}

/** Quote the same serializer, paying the planning scan now. Hold the actual failure-wire cost
 * before optional work; a refused candidate encode cannot consume its recovery envelope.
 * Callers supply the native owner's upper-bound work receipt to cover final-work self-accounting.
 */
export function reserveResearchFailureTransport(template: unknown, meter: SourceSemanticReadBudget): () => void {
  const quote = new SourceSemanticResourceLedger(meter.remaining());
  const length = quote.canonicalJsonLength(template, meter);
  chargeEncoding(length, quote);
  return meter.hold({ work_units: quote.spentWork, memory_bytes: quote.spentBytes });
}

function chargeEncoding(length: number, meter: Pick<SourceSemanticReadBudget, "charge">): void {
  meter.charge(length, length * 2, "research private reply encoding and worker transport");
}
