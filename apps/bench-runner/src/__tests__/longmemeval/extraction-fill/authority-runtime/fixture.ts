import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LongMemEvalQuestion } from
  "../../../../longmemeval/ingestion/dataset.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../../bench/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../../bench/extraction/authority/receipt.js";
import { EXTRACTION_FILL_VARIANT } from "../fixture.js";

interface AuthorityRoots {
  readonly cacheRoot: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
}

export async function writeAuthorityReceipt(
  roots: AuthorityRoots,
  input: {
    readonly limit?: number;
    readonly action?: "probe" | "fill";
    readonly variant?: typeof EXTRACTION_FILL_VARIANT | "longmemeval_s";
  }
): Promise<string> {
  const action = input.action ?? "fill";
  const variant = input.variant ?? EXTRACTION_FILL_VARIANT;
  const inspection = await inspectExtractionAuthority({
    variant,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...roots,
    revision: readCurrentExtractionAuthorityRevision(),
    action
  });
  const receipt = createExtractionAuthorityReceipt({
    action,
    observation: inspection.observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: inspection.writerLock,
      disk: inspection.disk,
      credentialStatus: inspection.credentialStatus,
      modelReadiness: inspection.modelReadiness
    },
    ...(action === "probe" ? { probeKey: inspection.missingKeys[0] } : {})
  });
  const path = join(roots.cacheRoot, `authority-receipt-${action}.json`);
  writeExtractionAuthorityReceipt(path, receipt);
  return path;
}

export async function writeCanonicalSFixtureDataset(
  roots: AuthorityRoots,
  writeDataset: (questions: readonly LongMemEvalQuestion[]) => Promise<void>,
  questions: readonly LongMemEvalQuestion[]
): Promise<void> {
  await writeDataset(questions);
  writeFixtureData(roots, questions, "longmemeval_s");
}

export function writeFixtureData(
  roots: Pick<AuthorityRoots, "dataDir" | "pinnedMetaRoot">,
  questions: readonly LongMemEvalQuestion[],
  variant = EXTRACTION_FILL_VARIANT
): void {
  const raw = JSON.stringify(questions);
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  writeFileSync(join(roots.dataDir, `${variant}.json`), raw, "utf8");
  writeFileSync(join(roots.pinnedMetaRoot, `${variant}.meta.json`), JSON.stringify({
    name: variant,
    sha256,
    size_bytes: Buffer.byteLength(raw, "utf8"),
    question_count: questions.length
  }), "utf8");
}

export function mutateFirstRawShard(cacheRoot: string): void {
  const prefix = readdirSync(cacheRoot).find((entry) => /^[0-9a-f]{2}$/u.test(entry));
  if (prefix === undefined) throw new Error("expected a cached extraction shard");
  const file = readdirSync(join(cacheRoot, prefix)).find((entry) => entry.endsWith(".json"));
  if (file === undefined) throw new Error("expected a cached extraction shard file");
  const path = join(cacheRoot, prefix, file);
  const shard = JSON.parse(readFileSync(path, "utf8")) as { raw_json: string };
  writeFileSync(path, JSON.stringify({ ...shard, raw_json: '{"signals":[],"mutated":true}' }), "utf8");
}

export function batchedFact(): string {
  return Array.from(
    { length: 9 },
    (_, index) => `I recorded durable detail number ${index + 1}.`
  ).join(" ");
}

export function singleSessionBatchedQuestion(id: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `What about ${id}?`,
    answer: `answer ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [`s-${id}`],
    haystack_dates: ["2025-12-01"],
    haystack_sessions: [[
      { role: "user", content: batchedFact(), has_answer: true },
      { role: "assistant", content: "Acknowledged." }
    ]],
    answer_session_ids: [`s-${id}`]
  };
}
