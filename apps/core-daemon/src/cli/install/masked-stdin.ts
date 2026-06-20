import { createInterface } from "node:readline/promises";
import type { ReadStream as TtyReadStream } from "node:tty";

type RawModeReadable = NodeJS.ReadableStream &
  Pick<TtyReadStream, "isRaw" | "setRawMode" | "setEncoding" | "resume" | "pause">;

export async function readSecretLine(
  stdin: NodeJS.ReadableStream,
  stderr: NodeJS.WritableStream,
  isTTY: boolean
): Promise<string> {
  if (isTTY) {
    return await readMaskedTtySecretLine(stdin, stderr);
  }
  const readline = createInterface({ input: stdin, terminal: false });
  try {
    return await readline.question("");
  } finally {
    readline.close();
  }
}

async function readMaskedTtySecretLine(
  stdin: NodeJS.ReadableStream,
  stderr: NodeJS.WritableStream
): Promise<string> {
  const preparedInput = prepareMaskedInput(stdin);
  return await new MaskedSecretLineReader(preparedInput, stderr).read();
}

function asRawModeReadable(stdin: NodeJS.ReadableStream): RawModeReadable | null {
  return typeof (stdin as Partial<TtyReadStream>).setRawMode === "function"
    ? (stdin as RawModeReadable)
    : null;
}

function restoreInput(input: RawModeReadable | null, rawModeChanged: boolean): void {
  if (input !== null && rawModeChanged) {
    input.setRawMode(false);
  }
  input?.pause();
}

function prepareMaskedInput(stdin: NodeJS.ReadableStream): Readonly<{
  input: RawModeReadable | null;
  readable: NodeJS.ReadableStream;
  rawModeChanged: boolean;
}> {
  const input = asRawModeReadable(stdin);
  const hadRawMode = input?.isRaw === true;
  let rawModeChanged = false;
  try {
    if (input !== null && !hadRawMode) {
      input.setRawMode(true);
      rawModeChanged = true;
    }
    input?.setEncoding("utf8");
    input?.resume();
    return { input, readable: input ?? stdin, rawModeChanged };
  } catch (error) {
    restoreInput(input, rawModeChanged);
    throw error;
  }
}

class MaskedSecretLineReader {
  private secret = "";
  private resolve: ((value: string) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private settled = false;
  private listenersAttached = false;

  public constructor(
    private readonly preparedInput: Readonly<{
      input: RawModeReadable | null;
      readable: NodeJS.ReadableStream;
      rawModeChanged: boolean;
    }>,
    private readonly stderr: NodeJS.WritableStream
  ) {}

  public async read(): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      try {
        this.attachListeners();
      } catch (error) {
        this.cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private attachListeners(): void {
    this.preparedInput.readable.on("data", this.onData);
    this.preparedInput.readable.on("error", this.onError);
    this.preparedInput.readable.on("end", this.onEnd);
    this.preparedInput.readable.on("close", this.onClose);
    this.listenersAttached = true;
  }

  private cleanup(): void {
    if (this.listenersAttached) {
      this.preparedInput.readable.off("data", this.onData);
      this.preparedInput.readable.off("error", this.onError);
      this.preparedInput.readable.off("end", this.onEnd);
      this.preparedInput.readable.off("close", this.onClose);
    }
    restoreInput(this.preparedInput.input, this.preparedInput.rawModeChanged);
    this.stderr.write("\n");
  }

  private finish(value: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup();
    this.resolve?.(value);
  }

  private fail(error: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup();
    this.reject?.(error);
  }

  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  private readonly onEnd = (): void => {
    this.fail(new Error("install --keychain secret input ended before newline"));
  };

  private readonly onClose = (): void => {
    this.fail(new Error("install --keychain secret input closed before newline"));
  };

  private readonly onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        this.finish(this.secret);
        return;
      }
      if (char === "\u0003") {
        this.fail(new Error("install --keychain canceled"));
        return;
      }
      if (char === "\u007f" || char === "\b") {
        this.secret = this.secret.slice(0, -1);
        continue;
      }
      this.secret += char;
    }
  };
}
