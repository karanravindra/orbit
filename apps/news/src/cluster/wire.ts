/**
 * Independent reports vs copies. One wire story (AP, Reuters, a station group) runs under dozens of headlines with
 * different site suffixes, so distinct text hashes still over-count. Two original reports on the same event are close
 * in embedding space too, but they do not share long runs of identical words, so copies are found by word overlap.
 * Port of the archived open-news `wire.ts`.
 */
const DATELINE = /^[A-Z][A-Za-z .,()'’-]{2,60}\s+[—–-]+\s+/; // "KYIV, Ukraine (AP) — "

export function shingles(text: string, n = 4): Set<string> {
  const words = text.replace(DATELINE, "").toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").split(" ").filter(Boolean).slice(0, 60);
  const out = new Set<string>();
  for (let i = 0; i < Math.max(1, words.length - n + 1); i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** Group index per input. Each text is compared with each group's first member only, so groups cannot chain A~B~C. */
export function wireGroups(texts: ReadonlyArray<string>, jaccardCut = 0.4): number[] {
  const leaders: Set<string>[] = [];
  return texts.map((text) => {
    const sh = shingles(text);
    for (let k = 0; k < leaders.length; k++) {
      const lead = leaders[k]!;
      let inter = 0;
      for (const s of sh) if (lead.has(s)) inter++;
      if (inter / (sh.size + lead.size - inter) >= jaccardCut) return k;
    }
    leaders.push(sh);
    return leaders.length - 1;
  });
}

/** Number of independent reports among `texts` (title + lede each). Empty/near-empty texts count as their own report. */
export const independentReports = (texts: ReadonlyArray<string>): number => new Set(wireGroups(texts)).size;
