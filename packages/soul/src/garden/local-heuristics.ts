import { randomUUID } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalSource,
  type CandidateMemorySignal,
  type SignalKind
} from "@do-soul/alaya-protocol";
import { GardenProviderKind, type GardenCompileContext, type GardenComputeProvider } from "./compute-provider.js";
import { buildHeuristicPreferenceProfile } from "./local-preference-profile.js";
import { buildSchemaGroundedRawPayload } from "./schema-grounding.js";
import {
  normalizeWindowDigest,
  resolveTemporalProjection,
  timeConcernPattern,
  type TemporalProjection
} from "./time-concern-projection.js";

interface PatternDefinition {
  readonly pattern: RegExp;
  readonly pattern_category: "preference" | "decision" | "constraint";
  readonly signal_kind: SignalKind;
  readonly object_kind: "preference" | "decision" | "constraint";
  readonly confidence: number;
}

interface TimeConcernMatch {
  readonly matched_text: string;
  readonly window_digest: string;
  readonly excerpt: string;
  readonly temporal_projection: TemporalProjection | null;
}

const PATTERNS: readonly PatternDefinition[] = [
  {
    pattern: /\bI always use\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "preference",
    signal_kind: "potential_preference",
    object_kind: "preference",
    confidence: 0.6
  },
  {
    pattern: /\bI prefer\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "preference",
    signal_kind: "potential_preference",
    object_kind: "preference",
    confidence: 0.55
  },
  {
    pattern: /\bMy preference is\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "preference",
    signal_kind: "potential_preference",
    object_kind: "preference",
    confidence: 0.55
  },
  {
    pattern: /\bNever use\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "preference",
    signal_kind: "potential_preference",
    object_kind: "preference",
    confidence: 0.45
  },
  {
    pattern: /\bWe decided\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "decision",
    signal_kind: "potential_claim",
    object_kind: "decision",
    confidence: 0.6
  },
  {
    pattern: /\bThe plan is to\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "decision",
    signal_kind: "potential_claim",
    object_kind: "decision",
    confidence: 0.55
  },
  {
    pattern: /\bLet's go with\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "decision",
    signal_kind: "potential_claim",
    object_kind: "decision",
    confidence: 0.5
  },
  {
    pattern: /\bI've chosen\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "decision",
    signal_kind: "potential_claim",
    object_kind: "decision",
    confidence: 0.55
  },
  {
    pattern: /\bMust always\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "constraint",
    signal_kind: "potential_claim",
    object_kind: "constraint",
    confidence: 0.6
  },
  {
    pattern: /\bCannot\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "constraint",
    signal_kind: "potential_claim",
    object_kind: "constraint",
    confidence: 0.55
  },
  {
    pattern: /\bRequired to\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "constraint",
    signal_kind: "potential_claim",
    object_kind: "constraint",
    confidence: 0.55
  },
  {
    pattern: /\bNever allow\b[^.!?\n]*[.!?]?/gi,
    pattern_category: "constraint",
    signal_kind: "potential_claim",
    object_kind: "constraint",
    confidence: 0.55
  },
  {
    pattern: /(?:我总是用|我偏好|我更喜欢|我的偏好是|不要用|从不用)[^.!?\n。！？]*[.!?。！？]?/gi,
    pattern_category: "preference",
    signal_kind: "potential_preference",
    object_kind: "preference",
    confidence: 0.55
  },
  {
    pattern: /(?:我们决定|计划是|打算|就用这个吧|让我们用|我选了|我选择了)[^.!?\n。！？]*[.!?。！？]?/gi,
    pattern_category: "decision",
    signal_kind: "potential_claim",
    object_kind: "decision",
    confidence: 0.55
  },
  {
    pattern: /(?:必须总是|一定要|不能|不可以|必须|要求|绝不允许|不允许)[^.!?\n。！？]*[.!?。！？]?/gi,
    pattern_category: "constraint",
    signal_kind: "potential_claim",
    object_kind: "constraint",
    confidence: 0.55
  },
  // Chinese self-introduction and naming preference. The bare "叫我<name>" form
  // is accepted only when it stands alone as a sentence, so imperative phrases
  // like "叫我一声，我马上过去" do not materialize as durable preferences.
  {
    pattern: /(?:(?:请叫我|我叫|我的名字是)[^.!?\n。！？]+|^叫我[\p{Script=Han}A-Za-z0-9_-]{1,12}[。！？!?]?$)/giu,
    pattern_category: "preference",
    signal_kind: "potential_preference",
    object_kind: "preference",
    confidence: 0.5
  }
] as const;

export class LocalHeuristics implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.LOCAL_HEURISTICS;

  public async compile(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly CandidateMemorySignal[]> {
    const normalizedTurnContent = turnContent.trim();
    if (normalizedTurnContent.length === 0) {
      return [];
    }

    const state = createCompileState(normalizedTurnContent, context);
    appendPatternSignals(state);
    appendTimeConcernSignals(state);
    return state.signals;
  }
}

interface CompileSignalState {
  readonly normalizedTurnContent: string;
  readonly context: GardenCompileContext;
  readonly createdAt: string;
  readonly seenMatches: Set<string>;
  readonly signals: CandidateMemorySignal[];
}

interface AppendCandidateInput {
  readonly signalKind: SignalKind;
  readonly objectKind: "preference" | "decision" | "constraint" | "fact";
  readonly confidence: number;
  readonly domainTags: readonly string[];
  readonly rawPayload: Record<string, unknown>;
}

function createCompileState(
  normalizedTurnContent: string,
  context: GardenCompileContext
): CompileSignalState {
  return {
    normalizedTurnContent,
    context,
    createdAt: new Date().toISOString(),
    seenMatches: new Set<string>(),
    signals: []
  };
}

function appendPatternSignals(state: CompileSignalState): void {
  for (const definition of PATTERNS) {
    for (const match of state.normalizedTurnContent.matchAll(definition.pattern)) {
      const matchedText = normalizeMatchedText(match[0]);
      if (
        matchedText.length === 0 ||
        !markSeenMatch(state, `${definition.signal_kind}:${matchedText.toLowerCase()}`)
      ) {
        continue;
      }
      appendPatternSignal(state, definition, matchedText);
    }
  }
}

function appendTimeConcernSignals(state: CompileSignalState): void {
  for (const timeConcern of extractTimeConcerns(state.normalizedTurnContent, state.createdAt)) {
    const dedupeKey =
      `potential_claim:time_concern:${timeConcern.window_digest}:` +
      `${timeConcern.excerpt.toLowerCase()}`;
    if (!markSeenMatch(state, dedupeKey)) {
      continue;
    }
    appendTimeConcernSignal(state, timeConcern);
  }
}

function markSeenMatch(state: CompileSignalState, dedupeKey: string): boolean {
  if (state.seenMatches.has(dedupeKey)) {
    return false;
  }
  state.seenMatches.add(dedupeKey);
  return true;
}

function appendPatternSignal(
  state: CompileSignalState,
  definition: PatternDefinition,
  matchedText: string
): void {
  const preferenceProfile = buildHeuristicPreferenceProfile(matchedText, definition.pattern_category);
  appendCandidateSignal(state, {
    signalKind: definition.signal_kind,
    objectKind: definition.object_kind,
    confidence: definition.confidence,
    domainTags: [],
    rawPayload: {
      matched_text: matchedText,
      pattern_category: definition.pattern_category,
      ...(preferenceProfile === null ? {} : { preference_profile: preferenceProfile }),
      turn_content_excerpt: buildTurnExcerpt(state.normalizedTurnContent, matchedText),
      full_turn_content: clampFullTurnContent(state.normalizedTurnContent)
    }
  });
}

function appendTimeConcernSignal(
  state: CompileSignalState,
  timeConcern: TimeConcernMatch
): void {
  appendCandidateSignal(state, {
    signalKind: "potential_claim",
    objectKind: "fact",
    confidence: 0.52,
    domainTags: ["time_concern"],
    rawPayload: {
      matched_text: timeConcern.matched_text,
      pattern_category: "time_concern",
      detected_object: {
        object_kind: "fact",
        confidence: 0.52
      },
      time_concern: {
        window_digest: timeConcern.window_digest,
        matched_text: timeConcern.matched_text,
        ...formatTemporalProjection(timeConcern.temporal_projection)
      },
      ...(timeConcern.temporal_projection === null
        ? {}
        : { temporal_projection: formatTemporalProjection(timeConcern.temporal_projection) }),
      distilled_fact: timeConcern.excerpt,
      field_candidates: [
        {
          field_name: "fact",
          value: timeConcern.excerpt,
          evidence: timeConcern.excerpt,
          confidence: 0.52
        }
      ],
      turn_content_excerpt: buildTurnExcerpt(state.normalizedTurnContent, timeConcern.excerpt),
      full_turn_content: clampFullTurnContent(state.normalizedTurnContent)
    }
  });
}

function appendCandidateSignal(
  state: CompileSignalState,
  input: AppendCandidateInput
): void {
  try {
    state.signals.push(
      CandidateMemorySignalSchema.parse({
        signal_id: randomUUID(),
        workspace_id: state.context.workspace_id,
        run_id: state.context.run_id,
        surface_id: state.context.surface_id,
        source: SignalSource.GARDEN_COMPILE,
        signal_kind: input.signalKind,
        object_kind: input.objectKind,
        scope_hint: null,
        domain_tags: [...input.domainTags],
        confidence: input.confidence,
        evidence_refs: [],
        raw_payload: buildSchemaGroundedRawPayload({
          signalKind: input.signalKind,
          objectKind: input.objectKind,
          confidence: input.confidence,
          rawPayload: input.rawPayload
        }),
        created_at: state.createdAt
      })
    );
  } catch (error) {
    console.warn("garden/local-heuristics: dropped one heuristic signal", {
      runId: state.context.run_id,
      signalKind: input.signalKind,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizeMatchedText(rawMatch: string): string {
  return rawMatch.trim();
}

function buildTurnExcerpt(turnContent: string, matchedText: string): string {
  const index = turnContent.indexOf(matchedText);
  if (index < 0) {
    return turnContent.slice(0, 160);
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(turnContent.length, index + matchedText.length + 40);
  return turnContent.slice(start, end).trim();
}

const MAX_FULL_TURN_CONTENT_CHARS = 2_048;

function clampFullTurnContent(turnContent: string): string {
  return turnContent.slice(0, MAX_FULL_TURN_CONTENT_CHARS);
}

function extractTimeConcerns(turnContent: string, anchorIso: string): readonly TimeConcernMatch[] {
  const pattern = timeConcernPattern();
  const matches: TimeConcernMatch[] = [];
  for (const sentence of splitSentences(turnContent)) {
    if (isQuestion(sentence)) {
      continue;
    }

    pattern.lastIndex = 0;
    for (const match of sentence.matchAll(pattern)) {
      const matchedText = normalizeMatchedText(match[0]);
      if (matchedText.length === 0) {
        continue;
      }
      matches.push({
        matched_text: matchedText,
        window_digest: normalizeWindowDigest(matchedText),
        excerpt: sentence,
        temporal_projection: resolveTemporalProjection(matchedText, anchorIso)
      });
    }
  }
  return matches;
}

function formatTemporalProjection(projection: TemporalProjection | null): Record<string, string> {
  if (projection === null) {
    return {};
  }
  return {
    event_time_start: projection.event_time_start,
    event_time_end: projection.event_time_end,
    time_precision: projection.time_precision,
    time_source: projection.time_source,
    projection_schema_version: String(projection.projection_schema_version)
  };
}

function splitSentences(turnContent: string): readonly string[] {
  return turnContent
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function isQuestion(sentence: string): boolean {
  return /[?？]\s*$/u.test(sentence);
}
