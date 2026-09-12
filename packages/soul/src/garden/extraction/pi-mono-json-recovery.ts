export type JsonRecoveryKind =
  | "none"
  | "markdown_strip"
  | "trailing_strip"
  | "balanced_close";

export interface ParseOrRecoverJsonOptions {
  readonly allowBalancedClose?: boolean;
}

export interface JsonRecoveryInspection {
  readonly rawJson: string;
  readonly recoveryKind: JsonRecoveryKind;
  readonly discardedCount: number;
}

export function parseOrRecoverJson(
  rawText: string,
  options: ParseOrRecoverJsonOptions = {}
): {
  readonly rawJson: string;
  readonly recoveryKind: JsonRecoveryKind;
} | null {
  const inspected = inspectJsonRecovery(rawText);
  if (inspected === null) {
    return null;
  }
  // Invented closers are not a successful parse unless a caller explicitly
  // opts in; truncation should retry instead.
  if (inspected.recoveryKind === "balanced_close" && options.allowBalancedClose !== true) {
    return null;
  }
  return { rawJson: inspected.rawJson, recoveryKind: inspected.recoveryKind };
}

export function inspectJsonRecovery(rawText: string): JsonRecoveryInspection | null {
  if (isParsableJsonObject(rawText)) {
    return { rawJson: rawText, recoveryKind: "none", discardedCount: 0 };
  }

  // Strategy 1: strip a leading ```json (or any language tag) fence and a
  // trailing ``` fence. Some providers (yunwu.ai-routed gpt-4.1-mini observed)
  // wrap JSON in a markdown code block even with response_format=json_object.
  const markdownStripped = stripMarkdownFence(rawText);
  if (markdownStripped !== null && isParsableJsonObject(markdownStripped)) {
    return { rawJson: markdownStripped, recoveryKind: "markdown_strip", discardedCount: 0 };
  }

  // Strategy 2: strip any text after the first balanced top-level JSON
  // object. Some models append "Note: ..." or a natural-language epilogue
  // after the JSON, which json_object response_format does not always
  // suppress on third-party gateways.
  const trailingStripped = stripTrailingText(
    markdownStripped ?? rawText
  );
  if (trailingStripped !== null && isParsableJsonObject(trailingStripped)) {
    return { rawJson: trailingStripped, recoveryKind: "trailing_strip", discardedCount: 0 };
  }

  const balancedClosed = closeUnbalancedBrackets(
    markdownStripped ?? rawText
  );
  if (balancedClosed !== null && isParsableJsonObject(balancedClosed)) {
    return { rawJson: balancedClosed, recoveryKind: "balanced_close", discardedCount: 1 };
  }

  return null;
}

function isParsableJsonObject(rawText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawText);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

// Strip an optional ``` or ```<lang> fence at the start and a ``` fence at
// the end. Returns null when there is no fence to strip (caller falls
// through to other recovery strategies on the original text).
function stripMarkdownFence(rawText: string): string | null {
  const trimmed = rawText.trim();
  const fenceStart = /^```[a-zA-Z0-9_-]*\s*\n?/u;
  const fenceEnd = /\n?```\s*$/u;
  const startMatch = fenceStart.exec(trimmed);
  const endMatch = fenceEnd.exec(trimmed);
  if (startMatch === null && endMatch === null) {
    return null;
  }
  let inner = trimmed;
  if (startMatch !== null) {
    inner = inner.slice(startMatch[0].length);
  }
  if (endMatch !== null) {
    inner = inner.slice(0, inner.length - endMatch[0].length);
  }
  const result = inner.trim();
  return result.length === 0 ? null : result;
}

// Find the FIRST `{` and walk balanced braces (respecting JSON strings and
// escapes) to find the matching `}`; return everything inclusive. Returns
// null when no balanced top-level object exists.
function stripTrailingText(rawText: string): string | null {
  const trimmed = rawText.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        // Only useful when we actually stripped a tail — otherwise this is
        // a strict-parsable body and step 1 already accepted it.
        if (candidate.length === trimmed.length) {
          return null;
        }
        return candidate;
      }
    }
  }
  return null;
}

// Detect a truncated tail by inventing closers for inspection only.
// parseOrRecoverJson does not treat this as success unless opted in.
function closeUnbalancedBrackets(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;
  let truncatedString = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      stack.push("{");
    } else if (ch === "[") {
      stack.push("[");
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
  }
  if (inString) {
    // A response truncated mid-string would need a closing quote before the
    // bracket close to be parseable. Add it so the recovery is honest about
    // what happened (the partial string remains, just terminated).
    truncatedString = true;
  }
  if (stack.length === 0 && !truncatedString) {
    return null;
  }
  let repaired = trimmed;
  if (truncatedString) {
    repaired = `${repaired}"`;
  }
  // Strip a dangling `,` before closing so `{"a":1,` becomes `{"a":1}` not
  // `{"a":1,}` (the latter is invalid JSON).
  repaired = repaired.replace(/,\s*$/u, "");
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  return repaired;
}
