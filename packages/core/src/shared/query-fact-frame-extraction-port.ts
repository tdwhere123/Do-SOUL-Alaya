import type { AssociativeFactFrame } from "@do-soul/alaya-protocol";

/** Read-only query parser seam. Implementations cannot write durable memory. */
export interface QueryFactFrameExtractionPort {
  readonly operator_id: string;
  extract(
    query: string,
    options?: Readonly<{ readonly maxFrames?: number }>
  ): Promise<readonly Readonly<AssociativeFactFrame>[]>;
}
