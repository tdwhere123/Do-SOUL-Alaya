export type SourceConversationRole = "user" | "assistant";

export interface SourceRoleMarker {
  readonly start: number;
  readonly role: SourceConversationRole;
}

const LEADING_MARKER_PADDING = String.raw`[\t\p{Zs}\p{Cf}]*`;
const HORIZONTAL_WHITESPACE = String.raw`[\t\p{Zs}]*`;
const ROLE_LABEL = String.raw`(\p{L}{1,16})`;
const ROLE_COLON = String.raw`(?::|：)`;
const ROLE_MARKER = `${LEADING_MARKER_PADDING}${ROLE_LABEL}` +
  `${HORIZONTAL_WHITESPACE}${ROLE_COLON}${HORIZONTAL_WHITESPACE}`;
const ROLE_BY_NORMALIZED_LABEL: Readonly<Record<string, SourceConversationRole>> = {
  user: "user",
  assistant: "assistant",
  用户: "user",
  助手: "assistant"
};

export function collectSourceRoleMarkers(sourceText: string): readonly SourceRoleMarker[] {
  const markers: SourceRoleMarker[] = [];
  for (const match of sourceText.matchAll(new RegExp(`^${ROLE_MARKER}`, "gimu"))) {
    const role = classifySourceRole(match[1]!);
    if (role !== undefined) markers.push({ start: match.index, role });
  }
  return markers;
}

export function sourceRoleMarkerPrefixLength(value: string): number {
  const match = new RegExp(`^${ROLE_MARKER}`, "iu").exec(value);
  return match !== null && classifySourceRole(match[1]!) !== undefined
    ? match[0].length
    : 0;
}

export function stripSourceRoleMarker(value: string): string {
  const trimmed = value.trim();
  const prefixLength = sourceRoleMarkerPrefixLength(trimmed);
  return trimmed.slice(prefixLength).trim();
}

function classifySourceRole(label: string): SourceConversationRole | undefined {
  const normalized = label.normalize("NFKC").toLowerCase();
  return ROLE_BY_NORMALIZED_LABEL[normalized];
}
