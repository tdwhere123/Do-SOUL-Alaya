export type JsonRecoveryKind =
  | "none"
  | "markdown_strip"
  | "trailing_strip"
  | "balanced_close";

export function parseOrRecoverJson(rawText: string): {
  readonly rawJson: string;
  readonly recoveryKind: JsonRecoveryKind;
} | null {
  if (isParsableJsonObject(rawText)) {
    return { rawJson: rawText, recoveryKind: "none" };
  }

  // Strategy 1: strip a leading ```json (or any language tag) fence and a
  // trailing ``` fence. Some providers (yunwu.ai-routed gpt-4.1-mini observed)
  // wrap JSON in a markdown code block even with response_format=json_object.
  const markdownStripped = stripMarkdownFence(rawText);
  if (markdownStripped !== null && isParsableJsonObject(markdownStripped)) {
    return { rawJson: markdownStripped, recoveryKind: "markdown_strip" };
  }

  // Strategy 2: strip any text after the first balanced top-level JSON
  // object. Some models append "Note: ..." or a natural-language epilogue
  // after the JSON, which json_object response_format does not always
  // suppress on third-party gateways.
  const trailingStripped = stripTrailingText(
    markdownStripped ?? rawText
  );
  if (trailingStripped !== null && isParsableJsonObject(trailingStripped)) {
    return { rawJson: trailingStripped, recoveryKind: "trailing_strip" };
  }

  // Strategy 3: close unbalanced brackets at the END of the buffer. A
  // max_tokens-truncated response loses its closing `]` or `}`. We close
  // them in the order they were opened so the resulting body is parseable.
  // Only runs after the above strategies fail, so a malformed-but-complete
  // body never gets a fake close appended.
  const balancedClosed = closeUnbalancedBrackets(
    markdownStripped ?? rawText
  );
  if (balancedClosed !== null && isParsableJsonObject(balancedClosed)) {
    return { rawJson: balancedClosed, recoveryKind: "balanced_close" };
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

// Append missing `}` / `]` in the order they were opened so a truncated
// JSON tail becomes parseable. Respects strings and escapes so brackets
// inside string literals are not mis-counted. Returns null when the body
// has no brackets to close (no `{` or `[` seen).
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
