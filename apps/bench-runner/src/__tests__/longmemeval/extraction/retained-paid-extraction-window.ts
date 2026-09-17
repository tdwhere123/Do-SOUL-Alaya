import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeOfficialApiSourceCorpusIdentity,
  parseOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { decodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";

const PAID_RELATIVE =
  ".do-it/bench-runs/associative-field-enrichment-readiness-20260914/first-stage-enrichment-canary/paid-eight-01";
const SOURCE_RELATIVE =
  ".do-it/bench-runs/associative-field-enrichment-readiness-20260914/enrichment-admission-consumption-repair/retained-source-corpus.txt";
const JOB = "556a08d8ab9630951c942167fc4de6fd38764fd945b204d52c561c187b1bb1a7";

export const RETAINED_PAID_OUTPUT_SHA256 =
  "b13a3d57ae50c8fa8eecc7c036da7d1c610a01dfd226f8bd259b16cdd05567e0";
export const RETAINED_PAID_REQUEST_KEY =
  "bf4d8fa195ea45afdddff2f0da7a418d5613318163af601760c0139c9133f07d";
export const RETAINED_PAID_MODEL = "gemini-3.1-flash-lite";
export const RETAINED_PAID_REQUEST_PROFILE = "gemini-3.1-low-v1" as const;

const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../");

export function resolveRepoRelativeArtifact(relativePath: string): string | null {
  if (relativePath === "" || isAbsolute(relativePath)) return null;
  const candidate = resolve(WORKTREE_ROOT, relativePath);
  const inside = relative(WORKTREE_ROOT, candidate);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  if (existsSync(candidate)) return candidate;
  return null;
}

export function readRetainedPaidExtractionWindow(): Readonly<{
  readonly rawJson: string;
  readonly request: OfficialApiExtractionRequest;
  readonly sourceCorpus: string;
  readonly outputSha256: string;
  readonly cacheRoot: string;
  readonly paidRoot: string;
}> | null {
  const paidRoot = resolveRepoRelativeArtifact(PAID_RELATIVE);
  const sourcePath = resolveRepoRelativeArtifact(SOURCE_RELATIVE);
  if (paidRoot === null || sourcePath === null) return null;
  const outputPath = join(paidRoot, "cache", `batch-output-${JOB}.jsonl`);
  const inputPath = join(paidRoot, "cache", `batch-input-${JOB}.jsonl`);
  if (!existsSync(outputPath) || !existsSync(inputPath)) return null;
  const outputBytes = readFileSync(outputPath);
  const outputLine = JSON.parse(outputBytes.toString("utf8").trim().split("\n")[0]!) as {
    readonly response?: unknown;
  };
  const inputLine = JSON.parse(readFileSync(inputPath, "utf8").trim().split("\n")[0]!) as {
    readonly request?: {
      readonly contents?: readonly {
        readonly parts?: readonly { readonly text?: string }[];
      }[];
    };
  };
  const userPrompt = inputLine.request?.contents?.[0]?.parts?.[0]?.text;
  if (typeof userPrompt !== "string") return null;
  const request = parseOfficialApiExtractionRequest(JSON.parse(userPrompt) as unknown);
  const sourceCorpus = readFileSync(sourcePath, "utf8");
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    throw new Error("retained source corpus identity does not match the packed request");
  }
  return {
    rawJson: decodeGeminiGenerateContent(outputLine.response).rawJson,
    request,
    sourceCorpus,
    outputSha256: createHash("sha256").update(outputBytes).digest("hex"),
    cacheRoot: join(paidRoot, "cache"),
    paidRoot
  };
}

export function requireRetainedPaidExtractionWindow(): NonNullable<
  ReturnType<typeof readRetainedPaidExtractionWindow>
> {
  const paid = readRetainedPaidExtractionWindow();
  if (paid === null) {
    throw new Error(
      "retained paid request/response or source corpus snapshot is absent; " +
        "cannot replay admission diagnostics"
    );
  }
  return paid;
}
