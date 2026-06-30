// Compose-then-rank activation assembly: groups recall candidates into entity-keyed units before ranking.

function flagEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw === "on" || raw === "1" || raw === "true";
}

// Master switch (default off → legacy flat path stays byte-identical).
export function composeRecallEnabled(): boolean {
  return flagEnabled("ALAYA_RECALL_COMPOSE");
}

export interface ActivationCandidate {
  readonly key: string | null;
  readonly members: readonly string[];
  readonly score: number;
}
