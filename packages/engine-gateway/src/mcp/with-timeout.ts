interface TimeoutError {
  readonly error_code: "handler_timeout";
  readonly message: string;
  readonly error_type: "TimeoutError";
}

export async function withTimeout<T>(
  operation: Promise<T> | (() => Promise<T>),
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error: TimeoutError = {
        error_code: "handler_timeout",
        message: "MCP tool execution timed out.",
        error_type: "TimeoutError"
      };
      reject(error);
    }, timeoutMs);
  });

  const work = typeof operation === "function" ? operation() : operation;
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
