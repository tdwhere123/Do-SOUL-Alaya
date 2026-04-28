import type { RuntimeSessionConfig, RuntimeTurnInput } from "@do-what/protocol";

/** Adapter-internal structural view of one official public SDK message. */
export interface ClaudeSDKMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ClaudeSDKTurnOptions {
  readonly sessionConfig: RuntimeSessionConfig;
  readonly input: RuntimeTurnInput;
}

export interface ClaudeSDKSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
}

export interface ClaudeSDKSlashCommandOptions {
  readonly sessionConfig: RuntimeSessionConfig;
}

export interface ClaudeSDKSlashCommandDispatchOptions extends ClaudeSDKSlashCommandOptions {
  readonly command: string;
}

export interface ClaudeSDKTurnHandle {
  /** Official public messages for one worker turn. */
  readonly messages: AsyncIterable<ClaudeSDKMessage>;
  /** Optional best-effort cancellation hook when the public surface supports it. */
  readonly cancel?: () => Promise<void>;
}

/**
 * Injection seam for the official Agent SDK.
 * Production: wraps the current stable public SDK surface.
 * Tests: returns scripted AsyncIterable fixtures.
 */
export interface ClaudeSDKClientFactory {
  startTurn(options: ClaudeSDKTurnOptions): Promise<ClaudeSDKTurnHandle>;
  listSupportedSlashCommands?(
    options: ClaudeSDKSlashCommandOptions
  ): Promise<readonly ClaudeSDKSlashCommand[]>;
  dispatchSlashCommand?(
    options: ClaudeSDKSlashCommandDispatchOptions
  ): Promise<string>;
}
