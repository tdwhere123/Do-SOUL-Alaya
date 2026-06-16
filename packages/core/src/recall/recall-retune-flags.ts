// Recall fusion retune bundle (F6 lexical composite, C2 embedding weight +
// injection, C3a temporal date-gate, C4 entity additive). Off by default so the
// production ranking stays byte-identical; the benchmark harness opts in to
// measure full-gold@5 before the defaults are locked. See
// .do-it/plans/claude/packages-layer.md §1.1-1.4.
const RECALL_FUSION_RETUNE_ENV = "ALAYA_RECALL_FUSION_RETUNE_V1";

export function recallFusionRetuneEnabled(): boolean {
  const raw = process.env[RECALL_FUSION_RETUNE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}
