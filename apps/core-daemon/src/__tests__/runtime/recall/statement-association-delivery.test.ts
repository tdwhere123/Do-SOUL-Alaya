import { afterEach, expect, it } from "vitest";
import { sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { fieldContractSha256, runConditionalFieldRecallWithReceipt, snapshotIdFromPin, type ObserverReaders } from "@do-soul/alaya-core";
import { prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import { STATEMENT_SESSION_IDLE_MS } from "../../../garden/statement-session/statement-session-closure.js";
import { createConditionalFieldObserverReaders, nominateNativeSources } from "../../../runtime/recall-read-worker/observer-operations.js";
import { prepareRecordedStatementIndex, RECORDED_STATEMENT_CONFIGURATION } from
  "../../../../../bench-runner/src/__tests__/support/recorded-statement-index.js";
import { CONTAINER, START, WORKSPACE, createStatementSessionEnvironment, hostMessages } from "../../garden/statement-session-fixture.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });
const QUERY = "zzqx", ROUNDS = 7;
const vector = { status: "available" as const, profile: RECORDED_STATEMENT_CONFIGURATION.profile,
  profile_id: sourceIndexProfileId(RECORDED_STATEMENT_CONFIGURATION.profile, fieldContractSha256),
  input_digest: `sha256:${fieldContractSha256(QUERY)}`, embedding: new Float32Array([1, 0, 0]) };

/** Rounds rank by their message vectors; round 4's statement key is weaker than round 5's on question
 * similarity and on link to rounds 0–3, so round 5 dominates source slot 5. */
async function publishedRounds() {
  const env = await createStatementSessionEnvironment(); environments.push(env);
  const turns = Array.from({ length: ROUNDS }, (_, k) => [{ role: "user" as const, content: `Round ${k}: I planted bed ${k}.` },
    { role: "assistant" as const, content: "Noted." }]);
  await env.capture({ container: CONTAINER, messages: hostMessages(turns) });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await env.processSession(env.provider(text => text.startsWith("Round ")
    ? [{ text: `The user planted a garden bed (${text.slice(0, 7)}).`, relation: "garden" }] : []));
  const roots = env.roots();
  expect(roots).toHaveLength(ROUNDS);
  prepareRecordedStatementIndex(env.database, WORKSPACE, source => {
    const round = roots.indexOf(source.target.root_id);
    if (round === -1) return [0, 0, 1];
    if (source.auxiliary === undefined) return [1, 0.2 * (round + 1), 0];
    return round === 4 ? [0.4, 0, 1] : [0.5, 0, 1];
  });
  prepareIndexedRecallProjection(env.database);
  return { env, roots };
}

function sourceOrder(env: Environment, readers: ObserverReaders): string[] {
  const request = { workspace_id: WORKSPACE, query_text: QUERY, readers,
    snapshot_id: snapshotIdFromPin(WORKSPACE, readers.snapshotPin!(WORKSPACE)),
    budget: { schema_version: 1 as const, work_units: 1_000_000, memory_bytes: 16_000_000,
      page_budget: 5, finalization_reserve: 512, min_envelope: 10 },
    interpretation_clock: START, as_of: START, expires_at: "2099-01-01T00:00:00.000Z", authorized_scopes: ["project"],
    enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const,
    protocol_version: 1 as const, supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    supports_source_evidence: true, supports_product_updates: true };
  const ids: string[] = [], pageSizes: number[] = [];
  let continuation: ReturnType<typeof runConditionalFieldRecallWithReceipt>["index"]["continuation"] | undefined;
  for (let page = 0; page < 10 && continuation !== null; page++) {
    const result = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt(
      { ...request, ...(continuation === undefined ? {} : { continuation }) }))();
    expect(result.index.result_version).toBe("ordinary-native-field.v9");
    const page = result.index.entries.flatMap(entry => entry.target.kind === "source_evidence" ? [entry.target.root_id] : []);
    ids.push(...page); pageSizes.push(page.length);
    continuation = result.index.continuation;
  }
  expect(continuation).toBeNull();
  // Slot 5 closes the first page, so the swapped pair straddles the continuation boundary.
  expect(pageSizes[0]).toBe(5);
  return ids;
}

it("swaps a dominated source slot 5 from published statement keys through SQLite across the first page boundary", async () => {
  const { env, roots } = await publishedRounds();
  const nominate = (funding: "allowance" | "request") => env.database.connection.transaction(() => nominateNativeSources(env.database,
    { workspaceId: WORKSPACE, query: QUERY, authorizedScopes: ["project"], budget: { work_units: 10_000_000, memory_bytes: 64_000_000 } },
    vector, undefined, funding))();
  const allowance = nominate("allowance");
  expect(allowance.association?.roots.length).toBe(allowance.result?.nominations.length);
  expect(allowance.association?.question.every(value => value > -1)).toBe(true);
  expect(allowance.result?.resource_refusals).toEqual([]);
  // Request-funded pages carry no association quote, so they never pay for or apply the swap.
  expect(nominate("request").association).toBeUndefined();

  const readers = createConditionalFieldObserverReaders(env.database, [], vector);
  const withoutAssociation: ObserverReaders = { ...readers, nominateSources: input => {
    const { association: _dropped, ...nomination } = readers.nominateSources!(input);
    return nomination;
  } };
  const baseline = sourceOrder(env, withoutAssociation);
  expect(baseline.slice(0, ROUNDS)).toEqual(roots);
  const swapped = [...baseline];
  [swapped[4], swapped[5]] = [swapped[5]!, swapped[4]!];
  expect(sourceOrder(env, readers)).toEqual(swapped);
});
