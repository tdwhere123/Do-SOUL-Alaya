export type SemanticHeadCandidate<T> = Readonly<{
  readonly candidate: T;
  readonly candidateKey: string;
  readonly index: number;
}>;
