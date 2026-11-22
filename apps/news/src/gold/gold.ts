import { TOPIC_IDS } from "../topics/taxonomy";

/**
 * A hand-labelled evaluation set for the topic classifier. One line of JSONL per story:
 * `label` is the single best section, `alt` an optional second section that is also defensible (a court ruling on tax is
 * politics or business). Strict accuracy counts `label` only; lenient accepts `alt` too. Stories are keyed by the embed_key of
 * their headline text, which survives `cluster --rebuild`.
 */
export interface GoldItem {
  readonly key: string;
  readonly headline: string;
  readonly titles: ReadonlyArray<string>;
  readonly label: string | null;
  readonly alt?: string | null;
}

export const parseGold = (text: string): GoldItem[] =>
  text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldItem);

export const formatGold = (items: ReadonlyArray<GoldItem>): string => items.map((i) => JSON.stringify(i)).join("\n") + "\n";

export interface Scored {
  readonly n: number;
  readonly strict: number;
  readonly lenient: number;
  readonly perTopic: ReadonlyArray<{ readonly topic: string; readonly support: number; readonly precision: number; readonly recall: number }>;
  /** Most frequent (gold -> predicted) mistakes, strict. */
  readonly confusions: ReadonlyArray<{ readonly gold: string; readonly predicted: string; readonly count: number }>;
}

export const score = (rows: ReadonlyArray<{ readonly label: string; readonly alt?: string | null; readonly predicted: string }>): Scored => {
  const n = rows.length;
  let strict = 0, lenient = 0;
  const conf = new Map<string, number>();
  for (const r of rows) {
    if (r.predicted === r.label) strict++;
    else conf.set(`${r.label}>${r.predicted}`, (conf.get(`${r.label}>${r.predicted}`) ?? 0) + 1);
    if (r.predicted === r.label || (r.alt && r.predicted === r.alt)) lenient++;
  }
  const perTopic = TOPIC_IDS.map((t) => {
    const support = rows.filter((r) => r.label === t).length;
    const predicted = rows.filter((r) => r.predicted === t).length;
    const hit = rows.filter((r) => r.label === t && r.predicted === t).length;
    return { topic: t, support, precision: predicted ? hit / predicted : 0, recall: support ? hit / support : 0 };
  }).filter((p) => p.support > 0);
  const confusions = [...conf].map(([k, count]) => { const [gold, predicted] = k.split(">"); return { gold: gold!, predicted: predicted!, count }; }).sort((a, b) => b.count - a.count).slice(0, 8);
  return { n, strict: n ? strict / n : 0, lenient: n ? lenient / n : 0, perTopic, confusions };
};
