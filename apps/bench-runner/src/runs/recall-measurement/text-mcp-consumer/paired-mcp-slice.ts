import { createHash } from "node:crypto";
import { AlayaError } from "@do-soul/alaya-protocol";
import { STEP_OPENAPI_QUOTE_BASIS, stepQuoteBasis } from "../../extraction/authority/step-quote.js";
import { estimatedSemanticProviderUpperUsd } from "../../provider-request/request-binding.js";
import { answerSystemFor, buildJudgePrompt, judgeIsCorrect } from "../../qa/qa-harness.js";
import {
  TEXT_MCP_PROVIDER_SESSION_CONTRACT, type TextMcpProviderSessionGrant
} from "./session-authority.js";
import type { TextMcpCallerCapabilityProfile, TextMcpCeilings, TextMcpRecallDispatchDefaults } from "./contract.js";
import { textMcpPromptOptions } from "./caller-capability-profile.js";

/** Frozen sample identity prefix. Not a module, fixture, or test name. */
const SLICE_FREEZE_CONTRACT = "C45-slice-v1";
export const PAIRED_MCP_SLICE_REQUEST_PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
export const PAIRED_MCP_SLICE_ARMS = [
  "plain_query", "agent_q_no_graph", "agent_q_conditional_field"
] as const;
export type PairedMcpSliceArm = (typeof PAIRED_MCP_SLICE_ARMS)[number];
export const PAIRED_MCP_SLICE_STRATA = [
  "qc_incomplete", "qc_blocked", "qc_invalid", "formed_outside_pool_preference",
  "multi_session", "temporal_reasoning", "cut_single_session_assistant"
] as const;
export type PairedMcpSliceStratum = (typeof PAIRED_MCP_SLICE_STRATA)[number];

const STRATUM_IDS: Readonly<Record<PairedMcpSliceStratum, readonly string[]>> = Object.freeze({
  qc_incomplete: Object.freeze([
    "46a3abf7", "gpt4_59c863d7", "b5ef892d", "60159905", "gpt4_2f56ae70", "gpt4_78cf46a3", "830ce83f", "5831f84d"
  ]),
  qc_blocked: Object.freeze(["eeda8a6d", "36b9f61e", "2ce6a0f2", "d851d5ba", "51c32626"]),
  qc_invalid: Object.freeze(["75832dbd"]),
  formed_outside_pool_preference: Object.freeze(["06f04340"]),
  multi_session: Object.freeze(["1c549ce4", "91b15a6e", "80ec1f4f", "37f165cf", "gpt4_2f91af09"]),
  temporal_reasoning: Object.freeze(["gpt4_e072b769", "gpt4_7f6b06db", "6e984301", "cc6d1ec1", "c8090214_abs"]),
  cut_single_session_assistant: Object.freeze(["b759caee", "7a8d0b71", "89527b6b", "fca762bc", "8b9d4367"])
});

const EXPECTED_TURNS = 3;
const EXPECTED_INPUT_TOKENS_PER_TURN = 3_000;
const EXPECTED_OUTPUT_TOKENS_PER_TURN = 400;
const MILLION = 1_000_000;
// Four-turn live transcripts with a ranked page, payload expansion, and pointer
// read exceeded 256 KiB once nested MCP JSON was serialized into the provider body.
const PAIRED_SLICE_INPUT_BYTE_UPPER = 320 * 1024;

export function pairedMcpSliceManifest(): readonly PairedMcpSliceItem[] {
  return PAIRED_MCP_SLICE_STRATA.flatMap(stratum =>
    STRATUM_IDS[stratum].map(questionId => {
      const freeze_key = `${SLICE_FREEZE_CONTRACT}|${stratum}|${questionId}`;
      return {
        stratum, question_id: questionId, freeze_key,
        freeze_sha256: createHash("sha256").update(freeze_key, "utf8").digest("hex")
      };
    }));
}

export function pairedMcpSliceQuestionIds(): readonly string[] {
  return pairedMcpSliceManifest().map(item => item.question_id);
}

export function pairedMcpSliceStratumCounts(): Readonly<Record<PairedMcpSliceStratum, number>> {
  return Object.fromEntries(PAIRED_MCP_SLICE_STRATA.map(stratum =>
    [stratum, STRATUM_IDS[stratum].length])) as Record<PairedMcpSliceStratum, number>;
}

export function verifyPairedMcpSliceDataset(
  questions: readonly Readonly<{ question_id: string }>[]
): Readonly<{ question_ids: readonly string[]; missing: readonly string[]; extra_prefix_collisions: readonly string[] }> {
  const present = new Set(questions.map(question => question.question_id));
  const ids = pairedMcpSliceQuestionIds();
  const missing = ids.filter(id => !present.has(id));
  if (ids.length !== 30 || new Set(ids).size !== 30) {
    throw new AlayaError("CONFLICT", "paired MCP slice must freeze exactly 30 unique items");
  }
  if (present.size !== questions.length) throw new AlayaError("CONFLICT", "paired MCP dataset contains duplicate question IDs");
  const extra_prefix_collisions = ids.flatMap(id =>
    questions.filter(question => question.question_id !== id && question.question_id.startsWith(id))
      .map(question => question.question_id));
  return { question_ids: ids, missing, extra_prefix_collisions };
}

export function pairedMcpSliceArmProfile(arm: PairedMcpSliceArm): TextMcpCallerCapabilityProfile {
  return arm === "plain_query" ? "plain_query" : "caller_coordinates";
}

export function pairedMcpSliceGrantLimits(input: Readonly<{ sharedInitialTurn1?: boolean }> = {}): PairedMcpSliceGrantLimits {
  const quote = stepQuoteBasis(STEP_OPENAPI_QUOTE_BASIS.selected_model, STEP_OPENAPI_QUOTE_BASIS.selected_provider_url);
  const modelTurns = input.sharedInitialTurn1 ? 3 : 4;
  const limits = {
    max_model_turns: modelTurns, max_tool_calls: 3, max_input_bytes: PAIRED_SLICE_INPUT_BYTE_UPPER, max_output_bytes: 64_000,
    wall_ms: 180_000, max_output_tokens: 4_096, maximum_input_tokens_per_attempt: PAIRED_SLICE_INPUT_BYTE_UPPER,
    maximum_attempts: modelTurns, maximum_attempts_per_key: 1 as const, concurrency: 1 as const, spend_ceiling_usd: 0
  };
  const per_session_upper_usd = estimatedSemanticProviderUpperUsd(limits,
    quote.input_usd_equivalent_per_million, quote.output_usd_equivalent_per_million);
  limits.spend_ceiling_usd = per_session_upper_usd;
  return { quote_basis: quote, limits, per_session_upper_usd, cohort_90_upper_usd: per_session_upper_usd * 90 };
}

export function expectedPairedMcpSliceSpend(turns = EXPECTED_TURNS): PairedMcpSliceExpectedSpend {
  const quote = STEP_OPENAPI_QUOTE_BASIS;
  const perTurnCny = (EXPECTED_INPUT_TOKENS_PER_TURN * quote.input_cny_per_million +
    EXPECTED_OUTPUT_TOKENS_PER_TURN * quote.output_cny_per_million) / MILLION;
  const per_session_cny = perTurnCny * turns;
  const per_session_usd = per_session_cny * quote.policy_usd_per_cny;
  return {
    turns, input_tokens_per_turn: EXPECTED_INPUT_TOKENS_PER_TURN,
    output_tokens_per_turn: EXPECTED_OUTPUT_TOKENS_PER_TURN,
    per_session_cny, per_session_usd, cohort_90_cny: per_session_cny * 90, cohort_90_usd: per_session_usd * 90
  };
}

export function quotePairedMcpSliceBudget(): PairedMcpSliceBudget {
  const granted = pairedMcpSliceGrantLimits();
  return {
    request_profile: PAIRED_MCP_SLICE_REQUEST_PROFILE, sessions: 90, paid_execution: false,
    quote_basis: granted.quote_basis, limits: granted.limits,
    estimated_upper: {
      per_session_usd: granted.per_session_upper_usd, cohort_90_usd: granted.cohort_90_upper_usd
    },
    expected: {
      low: expectedPairedMcpSliceSpend(2), typical: expectedPairedMcpSliceSpend(3),
      high: expectedPairedMcpSliceSpend(4)
    }
  };
}

export function buildPairedMcpSliceConsumerInput(input: Readonly<{
  config: unknown; root: string; query: { query_key: string; original_query: string };
}> & PairedMcpSliceScenario): PairedMcpSliceConsumerInput {
  const grant = pairedMcpSliceSessionGrantFields(input);
  const ceilings: TextMcpCeilings = {
    max_model_turns: grant.limits.max_model_turns, max_tool_calls: grant.limits.max_tool_calls,
    max_input_bytes: grant.limits.max_input_bytes, max_output_bytes: grant.limits.max_output_bytes,
    wall_ms: grant.limits.wall_ms
  };
  return {
    config: input.config, root: input.root, query: input.query, host_issued_initial_recall: false,
    ceilings, ...textMcpPromptOptions(grant),
    ...(grant.shared_initial_turn1 === undefined ? {} : { shared_initial_turn1: grant.shared_initial_turn1 })
  };
}

type PairedMcpSliceScenario = Readonly<{
  arm: PairedMcpSliceArm; question_date: string; interpretation_clock: string;
}> & Pick<TextMcpProviderSessionGrant, "shared_initial_turn1">;

export function pairedMcpSliceSessionGrantFields(input: PairedMcpSliceScenario):
  Pick<TextMcpProviderSessionGrant, "contract" | "host_issued_initial_recall" | "caller_capability_profile"
  | "question_date" | "recall_dispatch_defaults" | "limits" | "price" | "request_profile" | "model" | "provider_url"
  | "shared_initial_turn1"> {
  const granted = pairedMcpSliceGrantLimits({ sharedInitialTurn1: input.shared_initial_turn1 !== undefined });
  const quote = granted.quote_basis;
  return {
    contract: TEXT_MCP_PROVIDER_SESSION_CONTRACT, host_issued_initial_recall: false,
    caller_capability_profile: pairedMcpSliceArmProfile(input.arm), question_date: input.question_date,
    recall_dispatch_defaults: {
      result_kind_view: "source_only", source_observed_at: input.interpretation_clock
    },
    ...(input.shared_initial_turn1 === undefined ? {} : { shared_initial_turn1: input.shared_initial_turn1 }),
    limits: granted.limits, request_profile: PAIRED_MCP_SLICE_REQUEST_PROFILE,
    model: quote.selected_model, provider_url: quote.selected_provider_url,
    price: {
      input_usd_per_million: quote.input_usd_equivalent_per_million,
      output_usd_per_million: quote.output_usd_equivalent_per_million, quote_basis: quote
    }
  };
}

export function pairedMcpSliceJudgePrompt(input: Readonly<{
  questionType: string; isAbstention: boolean; question: string; goldAnswer: string; modelAnswer: string;
}>) {
  return {
    answer_system: answerSystemFor(input.questionType, input.isAbstention),
    judge: buildJudgePrompt(input)
  };
}

export function pairedMcpSliceJudgeCorrect(verdict: string): boolean {
  return judgeIsCorrect(verdict);
}

export function aggregatePairedMcpSliceSessions(
  sessions: readonly PairedMcpSliceSessionObservation[]
): PairedMcpSliceAggregate {
  const items = new Set(pairedMcpSliceQuestionIds());
  const observed = new Set<string>();
  for (const session of sessions) {
    const key = `${session.arm}:${session.question_id}`;
    if (!items.has(session.question_id) || !PAIRED_MCP_SLICE_ARMS.includes(session.arm) || observed.has(key)) {
      throw new AlayaError("CONFLICT", "paired MCP slice requires one observation per frozen item and arm");
    }
    observed.add(key);
  }
  const byArm = Object.fromEntries(PAIRED_MCP_SLICE_ARMS.map(arm => [arm, tallyArm(sessions, arm)])) as
    Record<PairedMcpSliceArm, PairedMcpSliceArmTally>;
  return {
    items: items.size, sessions: sessions.length, by_arm: byArm,
    signs: {
      plain_query_vs_agent_q_no_graph: signPair(sessions, "plain_query", "agent_q_no_graph"),
      plain_query_vs_agent_q_conditional_field: signPair(sessions, "plain_query", "agent_q_conditional_field"),
      agent_q_no_graph_vs_agent_q_conditional_field:
        signPair(sessions, "agent_q_no_graph", "agent_q_conditional_field")
    }
  };
}

export type PairedMcpSliceItem = Readonly<{
  stratum: PairedMcpSliceStratum; question_id: string; freeze_key: string; freeze_sha256: string;
}>;
export type PairedMcpSliceGrantLimits = Readonly<{
  quote_basis: ReturnType<typeof stepQuoteBasis>;
  limits: TextMcpProviderSessionGrant["limits"];
  per_session_upper_usd: number; cohort_90_upper_usd: number;
}>;
export type PairedMcpSliceExpectedSpend = Readonly<{
  turns: number; input_tokens_per_turn: number; output_tokens_per_turn: number;
  per_session_cny: number; per_session_usd: number; cohort_90_cny: number; cohort_90_usd: number;
}>;
export type PairedMcpSliceBudget = Readonly<{
  request_profile: typeof PAIRED_MCP_SLICE_REQUEST_PROFILE; sessions: 90; paid_execution: false;
  quote_basis: ReturnType<typeof stepQuoteBasis>; limits: TextMcpProviderSessionGrant["limits"];
  estimated_upper: Readonly<{ per_session_usd: number; cohort_90_usd: number }>;
  expected: Readonly<{
    low: PairedMcpSliceExpectedSpend; typical: PairedMcpSliceExpectedSpend; high: PairedMcpSliceExpectedSpend;
  }>;
}>;
export type PairedMcpSliceConsumerInput = Readonly<{
  config: unknown; root: string; query: { query_key: string; original_query: string };
  host_issued_initial_recall: false; ceilings: TextMcpCeilings;
  caller_capability_profile?: TextMcpCallerCapabilityProfile; question_date?: string;
  recall_dispatch_defaults?: TextMcpRecallDispatchDefaults;
}> & Pick<TextMcpProviderSessionGrant, "shared_initial_turn1">;
export type PairedMcpSliceSessionObservation = Readonly<{
  question_id: string; arm: PairedMcpSliceArm; correct: boolean | null; terminal: string;
  coordinate_admitted: boolean; payload_continuation_count: number; open_pointer_count: number;
  input_tokens: number; output_tokens: number; wall_ms: number;
}>;
export type PairedMcpSliceArmTally = Readonly<{
  sessions: number; correct: number; coordinate_admitted: number; payload_continuation_count: number;
  open_pointer_count: number; input_tokens: number; output_tokens: number; wall_ms: number;
  terminals: Readonly<Record<string, number>>;
}>;
export type PairedMcpSliceSign = Readonly<{ wins: number; losses: number; ties: number; compared: number }>;
export type PairedMcpSliceAggregate = Readonly<{
  items: number; sessions: number; by_arm: Readonly<Record<PairedMcpSliceArm, PairedMcpSliceArmTally>>;
  signs: Readonly<{
    plain_query_vs_agent_q_no_graph: PairedMcpSliceSign;
    plain_query_vs_agent_q_conditional_field: PairedMcpSliceSign;
    agent_q_no_graph_vs_agent_q_conditional_field: PairedMcpSliceSign;
  }>;
}>;

function tallyArm(
  sessions: readonly PairedMcpSliceSessionObservation[], arm: PairedMcpSliceArm
): PairedMcpSliceArmTally {
  const rows = sessions.filter(session => session.arm === arm);
  const terminals = new Map<string, number>();
  for (const row of rows) terminals.set(row.terminal, (terminals.get(row.terminal) ?? 0) + 1);
  return {
    sessions: rows.length, correct: rows.filter(row => row.correct === true).length,
    coordinate_admitted: rows.filter(row => row.coordinate_admitted).length,
    payload_continuation_count: sum(rows, row => row.payload_continuation_count),
    open_pointer_count: sum(rows, row => row.open_pointer_count),
    input_tokens: sum(rows, row => row.input_tokens), output_tokens: sum(rows, row => row.output_tokens),
    wall_ms: sum(rows, row => row.wall_ms), terminals: Object.fromEntries(terminals)
  };
}

function signPair(
  sessions: readonly PairedMcpSliceSessionObservation[], left: PairedMcpSliceArm, right: PairedMcpSliceArm
): PairedMcpSliceSign {
  const byItem = new Map<string, Partial<Record<PairedMcpSliceArm, boolean | null>>>();
  for (const row of sessions) {
    const current = byItem.get(row.question_id) ?? {};
    current[row.arm] = row.correct;
    byItem.set(row.question_id, current);
  }
  let wins = 0, losses = 0, ties = 0, compared = 0;
  for (const pair of byItem.values()) {
    const a = pair[left], b = pair[right];
    if (typeof a !== "boolean" || typeof b !== "boolean") continue;
    compared += 1;
    if (a === b) ties += 1;
    else if (a && !b) wins += 1;
    else losses += 1;
  }
  return { wins, losses, ties, compared };
}

function sum<T>(rows: readonly T[], read: (row: T) => number): number {
  return rows.reduce((total, row) => total + read(row), 0);
}
