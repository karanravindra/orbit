import { splitLine } from "./csv";
import type { OutletRow } from "./csv";
import { BIASES, type Bias } from "./bias";

export const score = (b: Bias): number => BIASES.indexOf(b) - 2;
/** Mean score back to a bucket; halves round toward the centre so a one-step disagreement never picks a side. */
export const fromScore = (x: number): Bias => BIASES[2 + Math.sign(x) * Math.ceil(Math.abs(x) - 0.5)]!;

const ALLSIDES: Record<string, Bias> = { left: "left", "left-center": "lean-left", center: "center", "right-center": "lean-right", right: "right" };

/** `name` lowercased, without a leading "the", parenthetical or punctuation: "The Hill (Online)" -> "hill". */
const nameKey = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
/** First label of the domain: "news.bbc.co.uk" -> "bbc" (the label before the public suffix, roughly). */
const domainKey = (d: string) => {
  const labels = d.split(".");
  const sld = labels.length > 2 && /^(co|com|org|net|gov|ac)$/.test(labels[labels.length - 2]!) ? labels[labels.length - 3]! : labels[labels.length - 2]!;
  return sld.replace(/[^a-z0-9]/g, "");
};

export interface AllSidesRow { readonly name: string; readonly bias: Bias }

/** Parse the AllSideR `allsides_data.csv` columns we need. Opinion/editorial sections and unrated rows are skipped. */
export const parseAllSides = (text: string): AllSidesRow[] => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = splitLine(lines.shift() ?? "");
  const [n, r] = [header.indexOf("news_source"), header.indexOf("rating")];
  if (n < 0 || r < 0) return [];
  const seen = new Set<string>();
  const out: AllSidesRow[] = [];
  for (const line of lines) {
    const cells = splitLine(line);
    const bias = ALLSIDES[cells[r] ?? ""];
    const name = cells[n] ?? "";
    if (!bias || /\((opinion|editorial|blog)/i.test(name) || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    out.push({ name, bias });
  }
  return out;
};

export interface Consensus {
  readonly rows: OutletRow[];
  readonly spreads: ReadonlyMap<string, number>;
  readonly matched: number;
  readonly disagreed: number;
  readonly changed: number;
}

/**
 * Fold a second rating source into the primary rows. An outlet matches when the AllSides name equals the outlet's
 * name or the domain's main label ("The Hill" ~ thehill.com). Matched outlets get the mean score (halves toward
 * the centre) and a `spread` recording the gap. Unmatched outlets are untouched.
 */
export const withAllSides = (primary: ReadonlyArray<OutletRow>, allsides: ReadonlyArray<AllSidesRow>): Consensus => {
  const byKey = new Map(allsides.map((a) => [nameKey(a.name), a.bias]));
  const spreads = new Map<string, number>();
  let matched = 0, disagreed = 0, changed = 0;
  const rows = primary.map((row) => {
    const dk = domainKey(row.domain);
    const other = byKey.get(dk) ?? byKey.get(dk.replace(/^the/, "")) ?? byKey.get(nameKey(row.name));
    if (!other) return row;
    matched++;
    const spread = Math.abs(score(row.bias) - score(other));
    spreads.set(row.domain, spread);
    if (spread > 0) disagreed++;
    const bias = fromScore((score(row.bias) + score(other)) / 2);
    if (bias !== row.bias) changed++;
    return { ...row, bias };
  });
  return { rows, spreads, matched, disagreed, changed };
};

export interface FamilyRule { readonly pattern: string; readonly family: string; readonly inheritFrom: string | null; readonly unratedOnly: boolean; readonly priority: number }

/** Parse `pattern,family,inherit_from,unrated_only,priority`. Patterns are Postgres regexes; bad ones are reported. */
export const parseFamilies = (text: string): { rules: FamilyRule[]; errors: string[] } => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  lines.shift();
  const rules: FamilyRule[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    // the pattern may contain commas inside {n,m}; the four trailing fields never do
    const parts = line.split(",");
    const tail = parts.splice(-4);
    const pattern = parts.join(",");
    const [family, inheritFrom, unrated, priority] = tail.map((s) => s.trim()) as [string, string, string, string];
    try { new RegExp(pattern); } catch { return void errors.push(`line ${i + 2}: bad pattern ${pattern}`); }
    if (!pattern || !family) return void errors.push(`line ${i + 2}: pattern and family are required`);
    rules.push({ pattern, family, inheritFrom: inheritFrom || null, unratedOnly: unrated !== "false", priority: Number(priority) || 100 });
  });
  return { rules, errors };
};
