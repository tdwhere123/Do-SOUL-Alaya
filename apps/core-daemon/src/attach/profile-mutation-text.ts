import { ProfileMutationError } from "./profile-mutation-types.js";

export function parseJsonObject(content: string | undefined, label: string): Record<string, unknown> {
  if (content === undefined || content.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("must contain a JSON object");
    }
    return { ...parsed };
  } catch (error) {
    throw new ProfileMutationError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      65
    );
  }
}

export function appendTomlBlock(content: string, block: string): string {
  const trimmed = content.trimEnd();
  return `${trimmed.length === 0 ? "" : `${trimmed}\n\n`}${block}\n`;
}

export function removeTomlBlock(content: string, header: string): string {
  const lines = content.split(/\r?\n/gu);
  const nextLines: string[] = [];
  let skipping = false;
  let removedAny = false;

  for (const line of lines) {
    if (line.trim() === header) {
      skipping = true;
      removedAny = true;
      continue;
    }

    if (skipping && /^\s*\[[^\]]+\]\s*$/u.test(line)) {
      skipping = false;
    }

    if (!skipping) {
      nextLines.push(line);
    }
  }

  if (!removedAny) {
    return content;
  }

  return `${nextLines.join("\n").trimEnd()}\n`;
}

export function extractTomlBlock(content: string, header: string): string | undefined {
  const lines = content.split(/\r?\n/gu);
  const block: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (line.trim() === header) {
      collecting = true;
    } else if (collecting && /^\s*\[[^\]]+\]\s*$/u.test(line)) {
      break;
    }
    if (collecting) {
      block.push(line);
    }
  }
  return block.length === 0 ? undefined : block.join("\n");
}

export function extractCodexSlashCommand(content: string): string | undefined {
  const block = extractTomlBlock(content, "[slash_commands.alaya-inspect]");
  if (block === undefined) {
    return undefined;
  }
  for (const line of block.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("command")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!rawValue.startsWith("\"")) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function normalizeFileText(content: string | undefined): string {
  return (content ?? "").replace(/\r\n/gu, "\n").trimEnd();
}

export function indentBlock(content: string): string {
  return content
    .split(/\r?\n/gu)
    .map((line) => `  ${line}`)
    .join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
