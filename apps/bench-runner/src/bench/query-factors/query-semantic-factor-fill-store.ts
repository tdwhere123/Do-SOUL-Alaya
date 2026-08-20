import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  OpenSemanticFactorFormationCaptureSchema,
  QueryOsfSemanticCompletenessReceiptSchema
} from "@do-soul/alaya-protocol";
import type { ExtractionTransportProvenance } from
  "../extraction/transport-route.js";
import { CURRENT_EXTRACTION_REQUEST_PROFILES } from
  "../extraction/request-profile.js";
import {
  QUERY_SEMANTIC_FACTOR_FILL_IDENTITY_SCHEMA_VERSION,
  queryCachePrefixedSha256,
  queryCacheSha256Hex
} from "./query-semantic-factor-cache-identity.js";
import { queryCacheStableJson } from "./cache/document.js";

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const FillIdentitySchema = z.object({
  schema_version: z.literal(QUERY_SEMANTIC_FACTOR_FILL_IDENTITY_SCHEMA_VERSION),
  compiler_operator_id: z.string().min(1),
  request_profile: z.enum(CURRENT_EXTRACTION_REQUEST_PROFILES),
  system_prompt_sha256: Sha256Schema,
  request_template_sha256: Sha256Schema,
  model_id: z.string().min(1),
  provider_url_sha256: Sha256Schema,
  source_set_sha256: Sha256Schema
}).strict();
const TransportSchema = z.object({
  provider_url_sha256: Sha256Schema,
  model: z.string().min(1)
}).strict();
const FillShardSchema = z.object({
  schema_version: z.literal(2),
  fill_identity_sha256: Sha256Schema,
  source_text: z.string().min(1),
  source_sha256: Sha256Schema,
  capture: OpenSemanticFactorFormationCaptureSchema,
  receipt: QueryOsfSemanticCompletenessReceiptSchema.nullable(),
  transport: TransportSchema
}).strict();

export type QuerySemanticFactorFillIdentity = z.infer<typeof FillIdentitySchema>;
export type QuerySemanticFactorFillShard = z.infer<typeof FillShardSchema>;

export async function openQuerySemanticFactorFillStore(input: Readonly<{
  outputPath: string;
  identity: QuerySemanticFactorFillIdentity;
}>): Promise<Readonly<{
  load(sourceText: string): Promise<QuerySemanticFactorFillShard | null>;
  put(input: Readonly<{
    source_text: string;
    source_sha256: string;
    capture: QuerySemanticFactorFillShard["capture"];
    receipt: QuerySemanticFactorFillShard["receipt"];
    transport: ExtractionTransportProvenance;
  }>): Promise<QuerySemanticFactorFillShard>;
}>> {
  const identity = FillIdentitySchema.parse(input.identity);
  const root = `${resolve(input.outputPath)}.partial`;
  const shardRoot = join(root, "shards");
  await mkdir(shardRoot, { recursive: true });
  const identityDigest = digestIdentity(identity);
  await ensureIdentity(join(root, "identity.json"), identity, identityDigest);
  return Object.freeze({
    load: async (sourceText) => await readShard(
      shardPath(shardRoot, sourceText), sourceText, identityDigest
    ),
    put: async (entry) => await putShard(shardRoot, identityDigest, entry)
  });
}

async function ensureIdentity(
  path: string,
  identity: QuerySemanticFactorFillIdentity,
  expectedDigest: string
): Promise<void> {
  try {
    await writeAtomicExclusive(path, `${JSON.stringify(identity, null, 2)}\n`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const persisted = FillIdentitySchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (digestIdentity(persisted) !== expectedDigest) {
    throw new Error("query semantic factor partial cache identity mismatch");
  }
}

async function putShard(
  shardRoot: string,
  identityDigest: string,
  input: Readonly<{
    source_text: string;
    source_sha256: string;
    capture: QuerySemanticFactorFillShard["capture"];
    receipt: QuerySemanticFactorFillShard["receipt"];
    transport: ExtractionTransportProvenance;
  }>
): Promise<QuerySemanticFactorFillShard> {
  const path = shardPath(shardRoot, input.source_text);
  const shard = FillShardSchema.parse({
    schema_version: 2,
    fill_identity_sha256: identityDigest,
    source_text: input.source_text,
    source_sha256: input.source_sha256,
    capture: input.capture,
    receipt: input.receipt,
    transport: input.transport
  });
  try {
    await writeAtomicExclusive(path, `${JSON.stringify(shard, null, 2)}\n`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const persisted = await readShard(path, input.source_text, identityDigest);
  if (persisted === null || persisted.source_sha256 !== input.source_sha256) {
    throw new Error("query semantic factor partial shard identity mismatch");
  }
  return persisted;
}

async function readShard(
  path: string,
  sourceText: string,
  identityDigest: string
): Promise<QuerySemanticFactorFillShard | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const shard = FillShardSchema.parse(JSON.parse(raw));
  if (shard.fill_identity_sha256 !== identityDigest ||
      shard.source_text !== sourceText ||
      shard.source_sha256 !== queryCachePrefixedSha256(sourceText)) {
    throw new Error("query semantic factor partial shard identity mismatch");
  }
  return shard;
}

async function writeAtomicExclusive(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function shardPath(root: string, sourceText: string): string {
  return join(root, `${queryCacheSha256Hex(sourceText)}.json`);
}

function digestIdentity(identity: QuerySemanticFactorFillIdentity): string {
  return queryCachePrefixedSha256(queryCacheStableJson(identity));
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
