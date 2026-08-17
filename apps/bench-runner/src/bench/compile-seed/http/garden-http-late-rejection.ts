export function observeLateGardenHttpRejection<T>(
  input: {
    readonly attempt: number;
    readonly controller: AbortController;
    readonly isAttemptSettled: () => boolean;
  },
  promise: Promise<T>,
  phase: "fetch" | "body read"
): void {
  void promise.catch((error: unknown) => {
    if (!input.isAttemptSettled() || input.controller.signal.aborted) return;
    console.warn(
      `bench-runner/garden-http-extractor: ${phase} rejected after outer settlement`,
      { attempt: input.attempt, error }
    );
  });
}
