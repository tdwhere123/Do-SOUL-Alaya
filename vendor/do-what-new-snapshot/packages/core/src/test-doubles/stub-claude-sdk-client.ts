import { RuntimeSessionConfigSchema, RuntimeTurnInputSchema } from "@do-what/protocol";
import type {
  ClaudeSDKClientFactory,
  ClaudeSDKMessage,
  ClaudeSDKTurnHandle,
  ClaudeSDKTurnOptions
} from "../runtime-adapters/claude-sdk-client.js";

export interface StubClaudeTurnScript {
  readonly messages: readonly ClaudeSDKMessage[];
  readonly error?: Error;
  readonly beforeComplete?: () => Promise<void>;
  /**
   * Cancel hook to expose on the turn handle.
   * Defaults to a no-op async function unless `omitCancel` is true.
   */
  readonly cancel?: () => Promise<void>;
  /**
   * When true, the turn handle exposes no cancel hook (cancel is undefined).
   * Use this to test adapter paths that handle missing interrupt support.
   */
  readonly omitCancel?: boolean;
  readonly onComplete?: () => Promise<void> | void;
}

export class StubClaudeSDKClientFactory implements ClaudeSDKClientFactory {
  private readonly scripts: StubClaudeTurnScript[];
  private nextScriptIndex = 0;

  public constructor(scripts: readonly StubClaudeTurnScript[]) {
    this.scripts = [...scripts];
  }

  public async startTurn(options: ClaudeSDKTurnOptions): Promise<ClaudeSDKTurnHandle> {
    RuntimeSessionConfigSchema.parse(options.sessionConfig);
    RuntimeTurnInputSchema.parse(options.input);

    const script = this.scripts[this.nextScriptIndex];
    this.nextScriptIndex += 1;

    if (script === undefined) {
      throw new Error("StubClaudeSDKClientFactory script exhausted.");
    }

    return {
      cancel: script.omitCancel ? undefined : (script.cancel ?? (async () => {})),
      messages: createAsyncIterable(script.messages, {
        beforeComplete: script.beforeComplete,
        error: script.error,
        onComplete: script.onComplete
      })
    };
  }
}

function createAsyncIterable(
  messages: readonly ClaudeSDKMessage[],
  options: {
    readonly beforeComplete?: () => Promise<void>;
    readonly error?: Error;
    readonly onComplete?: () => Promise<void> | void;
  }
): AsyncIterable<ClaudeSDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (const message of messages) {
          yield message;
        }

        await options.beforeComplete?.();

        if (options.error !== undefined) {
          throw options.error;
        }
      } finally {
        await options.onComplete?.();
      }
    }
  };
}
