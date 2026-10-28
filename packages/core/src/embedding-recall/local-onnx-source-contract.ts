/** The Source adapter and its IPC parent must agree on the selected encoder contract. */
export interface LocalOnnxSourceModelContract {
  readonly modelType: "bert" | "xlm-roberta";
  readonly dimensions: number;
  readonly pooling: "mean" | "cls";
  readonly normalization: string;
  readonly preprocessing?: string;
  readonly maxInputTokens?: number;
  readonly sourceOnly: boolean;
}

const LEGACY_SOURCE_MODEL: LocalOnnxSourceModelContract = Object.freeze({
  modelType: "bert", dimensions: 384, pooling: "mean",
  normalization: "attention-mask-mean.l2.q8.v1", sourceOnly: false
});
const BGE_M3_SOURCE_MODEL: LocalOnnxSourceModelContract = Object.freeze({
  modelType: "xlm-roberta", dimensions: 1024, pooling: "cls",
  normalization: "cls.l2.q8.v1", preprocessing: "raw-string.special-tokens.no-truncation.v1", maxInputTokens: 8192, sourceOnly: true
});

export function localOnnxSourceModelContract(modelId: string): LocalOnnxSourceModelContract {
  return modelId === "Xenova/bge-m3" ? BGE_M3_SOURCE_MODEL : LEGACY_SOURCE_MODEL;
}
