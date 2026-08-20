export interface RawOfficialApiSignalElementInspection {
  readonly elements: readonly string[];
  readonly truncated_final_element: boolean;
}

// Walk the `signals` array region without letting braces inside JSON strings
// change depth. A truncated final element is intentionally excluded while its
// presence remains available to offline parse-drop accounting.
export function inspectRawOfficialApiSignalElements(
  content: string
): RawOfficialApiSignalElementInspection {
  const signalsKeyIndex = findSignalsArrayStart(content);
  if (signalsKeyIndex < 0) {
    return { elements: [], truncated_final_element: false };
  }
  const elements: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let elementStart = -1;
  for (let i = signalsKeyIndex; i < content.length; i += 1) {
    const ch = content[i];
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
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) elementStart = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && elementStart >= 0) {
          elements.push(content.slice(elementStart, i + 1));
          elementStart = -1;
        }
      }
      continue;
    }
    if (ch === "]" && depth === 0) break;
  }
  return {
    elements,
    truncated_final_element: depth > 0 && elementStart >= 0
  };
}

export function salvageRawSignalElements(content: string): readonly string[] {
  return inspectRawOfficialApiSignalElements(content).elements;
}

function findSignalsArrayStart(content: string): number {
  const keyMatch = /"signals"\s*:\s*\[/u.exec(content);
  if (keyMatch === null) return -1;
  return keyMatch.index + keyMatch[0].length - 1;
}
