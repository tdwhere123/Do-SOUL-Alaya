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
  const input = asRawModeReadable(stdin);
  const hadRawMode = input?.isRaw === true;
  const canSetRawMode = input !== null;
  let rawModeChanged = false;
  try {
    if (canSetRawMode && !hadRawMode) {
      input.setRawMode(true);
      rawModeChanged = true;
    }
    input?.setEncoding("utf8");
    input?.resume();
  } catch (error) {
    restoreInput(input, rawModeChanged);
    throw error;
  }

  return await new Promise((resolve, reject) => {
    let secret = "";
    let settled = false;
    const readable = input ?? stdin;
    let listenersAttached = false;

    const cleanup = (): void => {
      if (listenersAttached) {
        readable.off("data", onData);
        readable.off("error", onError);
        readable.off("end", onEnd);
        readable.off("close", onClose);
      }
      restoreInput(input, rawModeChanged);
      stderr.write("\n");
    };

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onError = (error: Error): void => fail(error);
    const onEnd = (): void => fail(new Error("install --keychain secret input ended before newline"));
    const onClose = (): void => fail(new Error("install --keychain secret input closed before newline"));
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          finish(secret);
          return;
        }
        if (char === "\u0003") {
          fail(new Error("install --keychain canceled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += char;
      }
    };

    try {
      readable.on("data", onData);
      readable.on("error", onError);
      readable.on("end", onEnd);
      readable.on("close", onClose);
      listenersAttached = true;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
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
