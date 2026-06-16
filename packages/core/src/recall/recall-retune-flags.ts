// Opt-in flag for the recall-ranking retune (lexical-lane composite, raised
// embedding weight + injection, date-gated temporal, additive entity-seed). Off
// by default so production ranking stays byte-identical until the bench
// validates it.
const RECALL_FUSION_RETUNE_ENV = "ALAYA_RECALL_FUSION_RETUNE_V1";

export function recallFusionRetuneEnabled(): boolean {
  const raw = process.env[RECALL_FUSION_RETUNE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}
