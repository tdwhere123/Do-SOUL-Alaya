export interface DatasetMeta {
  readonly name: string;
  readonly source_url: string;
  readonly sha256: string | null;
  readonly size_sessions: number;
}

export const LONGMEMEVAL_S_META: DatasetMeta = {
  name: "LongMemEval-S",
  source_url: "https://github.com/xiaowu0162/LongMemEval",
  sha256: null,
  size_sessions: 500
};
