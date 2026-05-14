/**
 * @anchor SCORE_PREFIX_LEN — substring-prefix length used by the legacy
 * content-preview hit rule shared by self-bench and longmemeval runners.
 *
 * The rule: a recall pointer is treated as a hit when its content_preview
 * starts with (i.e. contains) the first SCORE_PREFIX_LEN characters of a
 * known seeded answer. This is a coarse oracle approximation — a real
 * scoring path should compare object_id against a seeded sidecar map so
 * the score does not depend on truncated string overlap.
 *
 * see also: apps/bench-runner/src/longmemeval/runner.ts (oracle approximation)
 * see also: apps/bench-runner/src/self/runner.ts (synthetic setup match)
 */
export const SCORE_PREFIX_LEN = 40;

/**
 * Returns true when the recall pointer's content_preview contains the
 * SCORE_PREFIX_LEN-char prefix of any expected content string. Pure helper
 * over the substring-prefix rule above — exposes no async / IO behavior so
 * a later replacement (sidecar lookup by object_id) can be threaded in
 * without changing the caller's loop shape.
 */
export function previewContainsExpectedPrefix(
  contentPreview: string,
  expectedContents: ReadonlyArray<string>
): boolean {
  return expectedContents.some((c) =>
    contentPreview.includes(c.slice(0, SCORE_PREFIX_LEN))
  );
}
