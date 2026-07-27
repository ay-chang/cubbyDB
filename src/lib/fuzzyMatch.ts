export interface FuzzyMatch {
  score: number;
  /** Indices into `target` (the string actually matched) that the query's
   *  characters landed on — for rendering a highlighted label. */
  indices: number[];
}

/**
 * Lightweight fuzzy matcher (VSCode quick-open style): prefers a contiguous
 * substring match — scored higher the earlier it starts — and falls back to
 * an in-order subsequence match otherwise, rewarding runs of consecutive
 * characters and matches closer to the start. Returns `null` when the
 * query's characters don't all appear in `target` in order.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const subIdx = t.indexOf(q);
  if (subIdx !== -1) {
    return {
      score: 1000 - subIdx * 2 - target.length,
      indices: Array.from({ length: q.length }, (_, i) => subIdx + i),
    };
  }

  const indices: number[] = [];
  let searchFrom = 0;
  let score = 0;
  let consecutive = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, searchFrom);
    if (found === -1) return null;
    consecutive =
      indices.length > 0 && found === indices[indices.length - 1] + 1 ? consecutive + 1 : 0;
    score += 10 + consecutive * 8 - (found - searchFrom);
    indices.push(found);
    searchFrom = found + 1;
  }
  return { score: score - target.length * 0.5, indices };
}

/**
 * The best match across several candidate strings describing the same item
 * (e.g. a bare name and a schema-qualified form). `candidate` says which
 * index in `candidates` actually matched, so callers rendering only one of
 * the candidates know whether `indices` applies to what's on screen.
 */
export function bestMatch(
  query: string,
  candidates: string[],
): (FuzzyMatch & { candidate: number }) | null {
  let best: (FuzzyMatch & { candidate: number }) | null = null;
  candidates.forEach((c, i) => {
    const m = fuzzyMatch(query, c);
    if (m && (!best || m.score > best.score)) best = { ...m, candidate: i };
  });
  return best;
}
