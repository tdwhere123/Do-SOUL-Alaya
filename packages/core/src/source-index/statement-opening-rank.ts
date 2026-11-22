/** Conservative work for ranking each root's opening statement. */
export const openingRankWork = (roots: number, statements: number) =>
  roots * statements * (4 + Math.ceil(Math.log2(roots + 1)));

/** The opening covers every necessary witness message of the root. Keys nominate witnesses;
 * physical messages, including unkeyed ones, define ordinary units. */
export function evidenceOpening(
  statement: number | null,
  cells: readonly ((readonly [number, number]) | null)[],
  firstMessageEnd: number | undefined
): Readonly<{ statement: number | null; span: readonly [number, number] }> | null {
  if (statement === null) return firstMessageEnd === undefined ? null : { statement, span: [0, firstMessageEnd] };
  let lo = Infinity, hi = -Infinity;
  for (const cell of cells) {
    if (cell === null) continue;
    lo = Math.min(lo, cell[0]); hi = Math.max(hi, cell[1]);
  }
  return { statement, span: [lo, hi] };
}

export function openingStatements(
  coverage: readonly (readonly (number | null)[])[],
  spans: readonly (readonly (readonly [number, number] | null)[])[],
  statements: number
): readonly (number | null)[] {
  if (statements === 1) return spans.map(row => row[0] === null ? null : 0);
  const best: (number | null)[] = Array(coverage.length).fill(null);
  const quantiles = new Float64Array(coverage.length);
  for (let column = 0; column < statements; column++) {
    const ranked: number[] = [];
    for (const [index, row] of coverage.entries()) if (row[column] !== null) ranked.push(index);
    ranked.sort((left, right) => coverage[right]![column]! - coverage[left]![column]!);
    let tiedRank = 0;
    for (const [rank, row] of ranked.entries()) {
      if (rank > 0 && coverage[row]![column] !== coverage[ranked[rank - 1]!]![column]) tiedRank = rank;
      const quantile = (ranked.length - tiedRank) / ranked.length;
      if (spans[row]![column] !== null && quantile > quantiles[row]!) {
        best[row] = column;
        quantiles[row] = quantile;
      }
    }
  }
  return best;
}
