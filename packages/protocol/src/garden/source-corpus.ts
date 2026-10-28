/** Canonical turn projection shared by source admission, grounding, and queued-source verification. */
export function canonicalSourceMessages(
  turnContent: string,
  messages: readonly Readonly<{ role: string; content: string }>[]
): readonly Readonly<{ role: string; source: string; original: string; normalized: string }>[] {
  const sourceMessages = messages.length === 0
    ? [{ role: "user" as const, content: turnContent }]
    : messages;
  return sourceMessages.map(message => {
    const normalized = message.content.trim().replace(/\s*[\r\n\u2028\u2029]+\s*/gu, " ");
    return { role: message.role, original: message.content, normalized,
      source: `${roleLabel(message.role)}: ${normalized}` };
  });
}

/** Boundaries are captured during rendering, never recovered from role markers. */
export function renderOfficialApiSourceCorpus(
  turnContent: string,
  messages: readonly Readonly<{ role: string; content: string }>[]
): Readonly<{ content: string; occurrences: readonly Readonly<{
  message_index: number; utf8_span: readonly [number, number]; fidelity: "original_bytes" | "normalized"
}>[] }> {
  const rendered = canonicalSourceMessages(turnContent, messages);
  let offset = 0;
  const occurrences = rendered.map((row, index) => {
    const start = offset + new TextEncoder().encode(`${roleLabel(row.role)}: `).length;
    offset += new TextEncoder().encode(row.source).length;
    const span = [start, offset] as const;
    offset += 1;
    return { message_index: index, utf8_span: span, fidelity: row.original === row.normalized
      ? "original_bytes" as const : "normalized" as const };
  });
  return { content: rendered.map(row => row.source).join("\n"), occurrences: messages.length === 0 ? [] : occurrences };
}

function roleLabel(role: string): "User" | "Assistant" {
  return role === "user" ? "User" : "Assistant";
}
