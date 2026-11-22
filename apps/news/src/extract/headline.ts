/**
 * Headline hygiene. Publishers append their own name ("Fire in Ohio | WKYC", "Fire in Ohio - The Guardian"), which makes
 * wire copies look distinct, clutters cards and costs tokens in every prompt. Titles are stored as fetched (the embedding
 * key is derived from them), so this runs wherever a title is shown or sent to a model.
 */

import { decodeEntities } from "./extract";

const SEP = /\s+[|–—•·:-]\s+/;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** "www.news.bbc.co.uk" -> "bbc" (second-level label), for matching against a title suffix. */
const domainLabel = (domain: string) => {
  const parts = domain.toLowerCase().replace(/^www\./, "").split(".");
  const tld = parts.length > 2 && parts[parts.length - 2]!.length <= 3 ? 3 : 2; // co.uk, com.au
  return parts[Math.max(0, parts.length - tld)] ?? parts[0] ?? "";
};

const looksLikeBrand = (suffix: string, sitename: string | null | undefined, domain: string | null | undefined) => {
  const s = norm(suffix);
  if (!s) return false;
  for (const known of [sitename, domain ? domainLabel(domain) : null]) {
    const k = known ? norm(known) : "";
    if (k && (s.includes(k) || (s.length >= 3 && k.includes(s)))) return true;
  }
  return false;
};

/**
 * Strip a trailing publisher name. A pipe is almost always a site suffix; other separators only when the tail matches
 * the article's site name or domain, or is a TV/radio call sign (WKYC, KTLA, "WSB-TV"), so "Trump - the sequel" survives.
 */
export const cleanTitle = (title: string, sitename?: string | null, domain?: string | null): string => {
  let t = decodeEntities(title).replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) {
    const m = t.match(new RegExp(`^(.*?)(${SEP.source})([^|–—•·]{2,60})$`, "u"));
    if (!m) break;
    const [, head, sep, tail] = m as unknown as [string, string, string, string];
    if (head.length < 12) break; // never reduce a headline to a fragment
    const callSign = /^(?:[KW][A-Z]{2,4}(?:-(?:TV|FM|AM|DT))?|[A-Z][A-Za-z0-9&.' ]{1,30}\s(?:News|Times|Post|Press|Herald|Tribune|Journal|Gazette))$/.test(tail.trim());
    const isPipe = sep.includes("|") || sep.includes("•");
    if (isPipe || looksLikeBrand(tail, sitename, domain) || callSign) t = head.trim();
    else break;
  }
  return t.replace(/\s*[|–—-]\s*$/, "");
};

/** Texts that differ only by a publisher suffix are one text: the key two copies of a wire headline share. */
export const headlineKey = (title: string) => norm(cleanTitle(title));
