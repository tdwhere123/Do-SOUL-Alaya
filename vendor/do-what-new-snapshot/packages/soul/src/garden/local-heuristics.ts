import { randomUUID } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalSource,
  type CandidateMemorySignal,
  type SignalKind
} from "@do-what/protocol";
import { GardenProviderKind, type GardenCompileContext, type GardenComputeProvider } from "./compute-provider.js";

interface PatternDefinition {
  readonly pattern: RegExp;
  readonly pattern_category: "preference" | "decision" | "constraint";
  readonly signal_kind: SignalKind;
  readonly object_kind: "preference" | "decision" | "constraint";
  readonly confidence: number;
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

    const createdAt = new Date().toISOString();
    const seenMatches = new Set<string>();
    const signals: CandidateMemorySignal[] = [];

    for (const definition of PATTERNS) {
      for (const match of normalizedTurnContent.matchAll(definition.pattern)) {
        const matchedText = normalizeMatchedText(match[0]);
        if (matchedText.length === 0) {
          continue;
        }

        const dedupeKey = `${definition.signal_kind}:${matchedText.toLowerCase()}`;
        if (seenMatches.has(dedupeKey)) {
          continue;
        }

        seenMatches.add(dedupeKey);
        signals.push(
          CandidateMemorySignalSchema.parse({
            signal_id: randomUUID(),
            workspace_id: context.workspace_id,
            run_id: context.run_id,
            surface_id: context.surface_id,
            source: SignalSource.GARDEN_COMPILE,
            signal_kind: definition.signal_kind,
            object_kind: definition.object_kind,
            scope_hint: null,
            domain_tags: [],
            confidence: definition.confidence,
            evidence_refs: [],
            raw_payload: {
              matched_text: matchedText,
              pattern_category: definition.pattern_category,
              turn_content_excerpt: buildTurnExcerpt(normalizedTurnContent, matchedText)
            },
            created_at: createdAt
          })
        );
      }
    }

    return signals;
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
