export type LocalOnnxCrossEncoderErrorCode = "DEPENDENCY_MISSING" | "MODEL_UNAVAILABLE"
  | "INVALID_INPUT" | "INVALID_OUTPUT" | "QUEUE_FULL" | "QUEUE_TIMEOUT"
  | "MODEL_LOAD_TIMEOUT" | "INFERENCE_TIMEOUT";

export class LocalOnnxCrossEncoderError extends Error {
  public readonly name = "LocalOnnxCrossEncoderError";
  public constructor(
    public readonly code: LocalOnnxCrossEncoderErrorCode,
    message: string,
    public readonly modelId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export function classifyLocalOnnxCrossEncoderLoadError(
  error: unknown,
  modelId: string,
  cacheDir: string | null
): LocalOnnxCrossEncoderError {
  if (error instanceof LocalOnnxCrossEncoderError) {
    return error;
  }
  if ((error as { readonly code?: string }).code === "ERR_MODULE_NOT_FOUND") {
    return new LocalOnnxCrossEncoderError(
      "DEPENDENCY_MISSING",
      "@huggingface/transformers is required for the local ONNX cross-encoder.",
      modelId,
      { cause: error }
    );
  }
  return new LocalOnnxCrossEncoderError(
    "MODEL_UNAVAILABLE",
    `Local ONNX cross-encoder model '${modelId}' was not available in cache '${cacheDir ?? "default"}'; remote loading is disabled.`,
    modelId,
    { cause: error }
  );
}
