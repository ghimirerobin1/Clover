/** Builds safe FTS5 MATCH expressions from free-text user input. */
export class FtsQuery {
  /**
   * "jas rice-20" → `"jas"* "rice"* "20"*` (AND of prefix terms).
   * Every token is quoted, so FTS5 operators/punctuation typed by the user can't break the query.
   * Returns null when there is nothing searchable.
   */
  static build(input: string): string | null {
    const tokens = input
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 8);
    if (tokens.length === 0) return null;
    return tokens.map((t) => `"${t}"*`).join(' ');
  }
}
