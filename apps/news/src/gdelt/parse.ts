/** Pure GDELT v2 GKG parsing. Network lives in Gdelt.ts. */
import { unzipSync } from "fflate";

export const BASE = "https://data.gdeltproject.org/gdeltv2";
export const SLICE_MS = 15 * 60 * 1000;

export interface GdeltRow {
  readonly url: string;
  readonly seen: Date;
  readonly titleHint: string | null;
}

/** 20251119213000 <-> Date */
export const stamp = (d: Date): string => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function parseStamp(s: string): Date | null {
  if (!/^\d{14}$/.test(s)) return null;
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)));
}

export const sliceUrl = (ts: Date): string => `${BASE}/${stamp(ts)}.gkg.csv.zip`;

/** Floor to the 15-minute grid GDELT publishes on. */
export const floorSlice = (d: Date): Date => new Date(Math.floor(d.getTime() / SLICE_MS) * SLICE_MS);

/** Timestamp of the newest published slice, from lastupdate.txt (lines are "size hash url"). */
export function parseLastUpdate(text: string): Date {
  const line = text.split("\n").find((l) => l.includes(".gkg."));
  const url = line?.trim().split(/\s+/)[2];
  const ts = url && parseStamp(url.split("/").pop()!.split(".")[0]!);
  if (!ts) throw new Error("could not parse lastupdate.txt");
  return ts;
}

const PAGE_TITLE = /<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/;

/** GKG v2.1 columns (tab-separated, unquoted): 1 DATE, 2 SourceCollectionIdentifier (1 = web),
 *  4 DocumentIdentifier (the URL), 26 Extras XML (may hold PAGE_TITLE). */
export function parseSlice(zipped: Uint8Array): GdeltRow[] {
  const first = Object.values(unzipSync(zipped))[0];
  if (!first) return [];
  const text = new TextDecoder("utf-8", { fatal: false }).decode(first);
  const out: GdeltRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    if (c[2] !== "1") continue; // web articles only (not JSTOR, CORE, ...)
    const url = c[4];
    const seen = parseStamp(c[1] ?? "");
    if (!url?.startsWith("http") || !seen) continue;
    out.push({ url, seen, titleHint: c[26]?.match(PAGE_TITLE)?.[1] ?? null });
  }
  return out;
}
