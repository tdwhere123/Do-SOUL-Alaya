export type ExtractionFillTerminationSignal = "SIGINT" | "SIGTERM";

export interface ExtractionFillSignalSource {
  on(signal: ExtractionFillTerminationSignal, handler: () => void): void;
  off(signal: ExtractionFillTerminationSignal, handler: () => void): void;
}

export class ExtractionFillInterruptedError extends Error {
  readonly exitCode: 130 | 143;

  constructor(signal: ExtractionFillTerminationSignal) {
    super(`extraction-fill interrupted by ${signal}`);
    this.name = "ExtractionFillInterruptedError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

export async function withExtractionFillSignalScope<T>(
  signalSource: ExtractionFillSignalSource,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort(new ExtractionFillInterruptedError("SIGINT"));
  };
  const onSigterm = (): void => {
    controller.abort(new ExtractionFillInterruptedError("SIGTERM"));
  };
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);
  try {
    return await task(controller.signal);
  } finally {
    signalSource.off("SIGINT", onSigint);
    signalSource.off("SIGTERM", onSigterm);
  }
}
