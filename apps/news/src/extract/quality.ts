/**
 * Cheap, rule-based gate for pages that are not news reports. They pollute rankings (a press release carried by 40
 * aggregators looks like a 40-outlet story) and clusters (every "Wordle hint" page merges into one). Conservative on purpose:
 * a miss costs a little noise; a false positive hides a real story.
 */
export type LowQuality = "press_release" | "roundup" | "listicle";

const PRESS_DOMAINS = /(^|\.)(prnewswire|businesswire|globenewswire|accesswire|einpresswire|prweb|newswire|issuewire|openpr|send2press|24-7pressrelease|prlog)\.(com|net|org|co|co\.uk)$/;
const PRESS_TEXT = /\b(?:PRNewswire|PR Newswire|BUSINESS WIRE|GLOBE NEWSWIRE|ACCESSWIRE|EIN Presswire|PRWeb)\b|\(?press release\)?\s*[-–—:]|\bfor immediate release\b/i;
const ROUNDUP =
  /\b(?:news in brief|morning (?:briefing|digest|newsletter|report)|evening (?:briefing|digest)|daily (?:briefing|digest|roundup|news roundup)|news roundup|the (?:morning|evening) (?:update|edition)|today'?s top (?:stories|headlines)|top headlines|headlines for [a-z]+ \d{1,2}|what'?s happening today|live updates?:? (?:day|week) \d+)\b/i;
const LISTICLE_TITLE = new RegExp(
  [
    "^\\d{1,3}\\s+(?:best|top|things|ways|reasons|signs|tips|facts|foods|movies|shows|songs|gifts|products|items|deals|apps|games|tricks|hacks|questions|celebrities|photos|pictures)\\b",
    "\\bbest\\b.*\\b(?:deals?|to buy|for \\d{4}|this (?:week|year)|picks)\\b",
    "\\b(?:coupon|promo code|discount code)\\b",
    "\\b(?:wordle|connections|strands|quordle|mini crossword|spelling bee)\\b.*\\b(?:hints?|answers?|today|#\\d+)\\b",
    "\\bhoroscope\\b",
    "\\b(?:today'?s|tonight'?s) (?:nyt )?(?:wordle|connections|strands)\\b",
    "\\bhow to watch\\b.*\\b(?:live ?stream|free|online|tv channel)\\b",
    "\\bwhat time (?:and|&) what channel\\b",
  ].join("|"),
  "i",
);

// Shopping-event copy ("Ring Camera drops below £20 in Black Friday deal") is not news; reporting about the event is.
const SALE_EVENT = /\b(?:black friday|cyber monday|prime day|boxing day sales?)\b/i;
const SALE_COPY = /\b(?:deals?|sale|bundle|offers?|discount|\d+% off|[£$€]\s?\d+(?:\.\d+)? off|drops? (?:to|below)|slashe?s?|lowest price)\b/i;
const NEWSY = /\b(?:report|survey|study|warns?|urges?|scams?|police|mail|post office|stores? (?:open|closed)|hours|opening|strike|protest|shoppers? (?:should|beware)|sales (?:figures|forecast)|retailers?|spending|crowds?|injur\w+|arrest\w*)\b/i;

export const lowQuality = (title: string | null, lede: string | null, domain?: string | null): LowQuality | null => {
  const t = title ?? "";
  if ((domain && PRESS_DOMAINS.test(domain)) || PRESS_TEXT.test(t) || PRESS_TEXT.test((lede ?? "").slice(0, 160))) return "press_release";
  if (ROUNDUP.test(t)) return "roundup";
  if (LISTICLE_TITLE.test(t) || (SALE_EVENT.test(t) && SALE_COPY.test(t) && !NEWSY.test(t))) return "listicle";
  return null;
};
