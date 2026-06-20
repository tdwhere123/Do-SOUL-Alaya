import type { AlayaCliArgsSchema } from "../bridge.js";
import { sanitizeInstallError, type InstallArgs, type InstallAnswers } from "./support.js";

export function installArgsSchema(): AlayaCliArgsSchema<InstallArgs> {
  return {
    safeParse(input) {
      return parseInstallArgsInput(input);
    }
  };
}

function parseInstallArgsInput(
  input: unknown
):
  | { readonly success: true; readonly data: InstallArgs }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[] } } {
  if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
    return {
      success: false,
      error: { issues: [{ path: [], message: "Expected a string argument list." }] }
    };
  }

  if (input.length === 0) {
    return { success: true, data: { nonInteractive: false, answers: null, force: false, keychain: false } };
  }

  const tokens = [...input];
  const { keychain, force } = extractBooleanFlags(tokens);
  const nonInteractiveIndex = tokens.indexOf("--non-interactive");
  if (nonInteractiveIndex < 0) {
    return parseInteractiveInstallArgs(tokens, { keychain, force });
  }
  tokens.splice(nonInteractiveIndex, 1);
  return parseNonInteractiveInstallArgs(tokens, { keychain, force });
}

function extractBooleanFlags(tokens: string[]): { readonly keychain: boolean; readonly force: boolean } {
  const keychainIndex = tokens.indexOf("--keychain");
  const keychain = keychainIndex >= 0;
  if (keychain) {
    tokens.splice(keychainIndex, 1);
  }
  const forceIndex = tokens.indexOf("--force");
  const force = forceIndex >= 0;
  if (force) {
    tokens.splice(forceIndex, 1);
  }
  return { keychain, force };
}

function parseInteractiveInstallArgs(
  tokens: string[],
  flags: Readonly<{ keychain: boolean; force: boolean }>
) {
  if (flags.keychain && tokens.length === 0) {
    return { success: true, data: { nonInteractive: false, answers: null, force: flags.force, keychain: true } } as const;
  }
  return {
    success: false,
    error: {
      issues: [{ path: [], message: "Usage: install [--keychain] | install --non-interactive [--json] [--force] <answers-json>" }]
    }
  } as const;
}

function parseNonInteractiveInstallArgs(
  tokens: string[],
  flags: Readonly<{ keychain: boolean; force: boolean }>
) {
  const jsonIndex = tokens.indexOf("--json");
  if (jsonIndex >= 0) {
    tokens.splice(jsonIndex, 1);
  }
  if (flags.keychain) {
    return parseNonInteractiveKeychainArgs(tokens, flags.force);
  }
  if (tokens.length !== 1) {
    return {
      success: false,
      error: { issues: [{ path: [], message: "install --non-interactive requires one JSON answer object." }] }
    } as const;
  }
  return parseInstallAnswersJson(tokens[0]!, flags);
}

function parseNonInteractiveKeychainArgs(tokens: string[], force: boolean) {
  if (tokens.length === 0) {
    return { success: true, data: { nonInteractive: true, answers: null, force, keychain: true } } as const;
  }
  return {
    success: false,
    error: {
      issues: [
        {
          path: [],
          message: "install --keychain --non-interactive does not accept an answer JSON or secret argument."
        }
      ]
    }
  } as const;
}

function parseInstallAnswersJson(
  rawToken: string,
  flags: Readonly<{ keychain: boolean; force: boolean }>
) {
  try {
    const parsed = JSON.parse(rawToken) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("answers must be an object");
    }
    return {
      success: true,
      data: { nonInteractive: true, answers: parsed as InstallAnswers, force: flags.force, keychain: flags.keychain }
    } as const;
  } catch (error) {
    return {
      success: false,
      error: { issues: [{ path: [], message: sanitizeInstallError(error) }] }
    } as const;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
