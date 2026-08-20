import { DatabaseSync } from "node:sqlite";
import { resolveOfficialApiSystemPrompt } from "@do-soul/alaya-soul";
import { EXTRACTION_CACHE_KEY_ALGO, EXTRACTION_CACHE_MANIFEST_VERSION } from
  "../../extraction/cache/extraction-cache-manifest.js";
import type { SnapshotExtractionAuthority } from "../extraction-authority.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import type {
  LongMemEvalSnapshotSidecarFile,
  SnapshotExtractionProvenance
} from "../materialize.js";
import type { SeedExtractionPath } from "@do-soul/alaya-eval";
import type { ExtractionContentClosureEntry } from "../../compile-seed/compile-seed-cache.js";
import type { SourceAssertionSupplementBinding } from
  "../../extraction/cache/semantic-supplement/source-assertion-supplement.js";
import {
  assertSemanticSupplementClosure,
  createSemanticSupplementEntries
} from "./semantic-supplement-binding.js";
import { assertQuestionLedger } from "./seed-ledger-rounds.js";
import { assertCacheClosure, assertSeedExtractionPath } from "./seed-ledger-closure.js";
import {
  emptyTotals,
  sha256,
  type CompleteExtraction,
  type SnapshotSeedLedgerClosureAuthority
} from "./seed-ledger-shared.js";

export type { SnapshotSeedLedgerClosureAuthority } from "./seed-ledger-shared.js";

export function assertSnapshotSeedLedgerBinding(input: {
  readonly dbPath: string;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly extraction: SnapshotExtractionProvenance | null;
  readonly extractionAuthority: SnapshotExtractionAuthority;
  readonly seedExtractionPath: SeedExtractionPath | undefined;
  readonly closureAuthority: SnapshotSeedLedgerClosureAuthority;
  readonly systemPrompt?: string;
  readonly semanticSupplementBinding?: SourceAssertionSupplementBinding;
}): void {
  const resolved = requireCompleteExtraction(input.extraction, input.systemPrompt);
  const extraction = resolved.extraction;
  const systemPrompt = resolved.systemPrompt;
  const totals = emptyTotals();
  const closure = new Map<string, ExtractionContentClosureEntry>();
  const semanticEntries = createSemanticSupplementEntries();
  const db = new DatabaseSync(input.dbPath, { readOnly: true });
  try {
    input.sidecar.questions.forEach((question, index) => {
      const source = input.questions[index];
      if (source === undefined) throw new Error("snapshot seed ledger question order mismatch");
      assertQuestionLedger(
        db, question, source, extraction, totals, closure, semanticEntries,
        input.semanticSupplementBinding, systemPrompt
      );
    });
  } finally {
    db.close();
  }
  assertCacheClosure(
    extraction,
    input.extractionAuthority,
    closure,
    input.closureAuthority
  );
  assertSemanticSupplementClosure(
    extraction,
    semanticEntries,
    input.semanticSupplementBinding
  );
  assertSeedExtractionPath(input.seedExtractionPath, totals);
}

function requireCompleteExtraction(
  value: SnapshotExtractionProvenance | null,
  requiredSystemPrompt: string | undefined
): Readonly<{
  readonly extraction: CompleteExtraction;
  readonly systemPrompt: string;
}> {
  if (value?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION ||
      value.fill_status !== "complete" || value.content_closure_sha256 === undefined ||
      value.expected_turns === undefined || value.expected_key_set_sha256 === undefined ||
      value.request_profile === undefined ||
      value.cache_key_algo !== EXTRACTION_CACHE_KEY_ALGO) {
    throw new Error("promotion snapshot extraction closure is incomplete or drifted");
  }
  const systemPrompt = requiredSystemPrompt ??
    resolveOfficialApiSystemPrompt(value.system_prompt_sha256);
  if (systemPrompt === undefined || value.system_prompt_sha256 !== sha256(systemPrompt)) {
    throw new Error("promotion snapshot extraction closure is incomplete or drifted");
  }
  return Object.freeze({
    extraction: value as CompleteExtraction,
    systemPrompt
  });
}
