import { expect, test } from "bun:test";
import { independentReports, wireGroups } from "../src/cluster/wire";
import { cleanTitle, headlineKey } from "../src/extract/headline";
import { lowQuality } from "../src/extract/quality";
import { formatGold, parseGold, score } from "../src/gold/gold";
import { pickSources, shouldRewrite } from "../src/pipeline/Summaries";
import { PROMPT_VERSION, checkSummary, extractive, messagesFor } from "../src/summaries/prompt";

test("quality: press releases, roundups and listicles are caught; real news and shopping-event reporting are not", () => {
  expect(lowQuality("Acme Announces New Widget", "NEW YORK, Nov. 22 /PRNewswire/ -- Acme today", "example.com")).toBe("press_release");
  expect(lowQuality("Anything", "x", "www.prnewswire.com")).toBe("press_release");
  expect(lowQuality("AP News in Brief at 6:04 a.m. EST", null)).toBe("roundup");
  expect(lowQuality("The Hindu Morning Digest: November 22, 2026", null)).toBe("roundup");
  expect(lowQuality("7 Best Sword-Fighting Anime Like Black Clover", null)).toBe("listicle");
  expect(lowQuality("Today's NYT Connections hints and answers for Nov 22", null)).toBe("listicle");
  expect(lowQuality("B&Q Black Friday sale takes £50 off storage box", null)).toBe("listicle");
  expect(lowQuality("Will mail be delivered on Thanksgiving and Black Friday? What to know", null)).toBeNull();
  expect(lowQuality("Black Friday isn’t always cheaper, report finds", null)).toBeNull();
  expect(lowQuality("Senate passes budget bill after overnight session", "WASHINGTON (AP) — The Senate", "apnews.com")).toBeNull();
});

test("headline: publisher suffixes are stripped, real headline text is not", () => {
  expect(cleanTitle("Fire guts Ohio warehouse | WKYC")).toBe("Fire guts Ohio warehouse");
  expect(cleanTitle("Fire guts Ohio warehouse - The Guardian", "The Guardian", "theguardian.com")).toBe("Fire guts Ohio warehouse");
  expect(cleanTitle("Fire guts Ohio warehouse - WSB-TV")).toBe("Fire guts Ohio warehouse");
  expect(cleanTitle("Fire guts Ohio warehouse | Local News | Daily Gazette")).toBe("Fire guts Ohio warehouse");
  expect(cleanTitle("Trump signs order - and critics respond immediately")).toBe("Trump signs order - and critics respond immediately");
  expect(cleanTitle("Short | Site")).toBe("Short | Site"); // never reduce a headline to a fragment
  expect(cleanTitle("Lotus won&#8217;t bloom | WKYC")).toBe("Lotus won’t bloom");
  expect(headlineKey("Fire guts Ohio warehouse | WKYC")).toBe(headlineKey("Fire guts Ohio warehouse | KTLA"));
});

test("wire: copies with different headlines fold into one report, original reports stay separate", () => {
  const wire = "WASHINGTON (AP) — The Senate on Friday passed a sweeping budget bill after an overnight session that stretched into the morning hours, sending it to the House.";
  const copy = "The Senate on Friday passed a sweeping budget bill after an overnight session that stretched into the morning hours, sending it to the House.";
  const own = "Republicans celebrated while Democrats warned of cuts to health programs, saying the budget measure would raise premiums for millions of families next year.";
  expect(wireGroups([wire, copy, own])).toEqual([0, 0, 1]);
  expect(independentReports([wire, copy, own, wire])).toBe(2);
  expect(independentReports([])).toBe(0);
});

const src = [{ outlet: "A", title: "Lakemont approves bond", text: "Voters approved a $40 million bond on Tuesday by 58% to 42%. Construction starts next spring." }];
test("summary checks: format, length, invented numbers", () => {
  const ok = "Lakemont voters approved a $40 million bond on Tuesday, passing it 58% to 42%. Construction is due to begin next spring.";
  expect(checkSummary(ok, src)).toBeNull();
  expect(checkSummary("Here is the summary: voters approved a $40 million bond on Tuesday.", src)).toBe("has a preface");
  expect(checkSummary("Lakemont voters approved a $55 million bond on Tuesday, passing it 58% to 42% in a big win.", src)).toMatch(/ungrounded number 55/);
  expect(checkSummary("Too short.", src)).toBe("too short");
  expect(checkSummary(("word ".repeat(90)).trim(), src)).toMatch(/too long/);
  expect(checkSummary("- Voters approved a $40 million bond on Tuesday\n- Construction starts next spring and is due", src)).toBe("is a list");
});

test("summary prompt: single article vs several, extractive fallback", () => {
  expect(messagesFor(src)[1]!.content).toContain("news article");
  expect(messagesFor([...src, { outlet: "B", title: "t", text: "x" }])[1]!.content).toContain("[Source 2: B]");
  expect(extractive("First sentence here. Second sentence follows. Third one is long enough to be cut off by the limit, probably.", 60)).toBe("First sentence here. Second sentence follows.");
  expect(extractive(null)).toBeNull();
});

test("summaries: rewrite only on material growth, prompt change, or first write", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const old = { inputHash: "a", model: "m", version: PROMPT_VERSION, indep: 10, generatedAt: new Date(now - 3_600_000) };
  expect(shouldRewrite(null, { hash: "a", model: "m", indep: 1 }, now)).toBe(true);
  expect(shouldRewrite(old, { hash: "a", model: "m", indep: 99 }, now)).toBe(false); // same sources
  expect(shouldRewrite(old, { hash: "b", model: "m", indep: 12 }, now)).toBe(false); // trickle
  expect(shouldRewrite(old, { hash: "b", model: "m", indep: 16 }, now)).toBe(true); // +6, 1.6x
  expect(shouldRewrite({ ...old, generatedAt: new Date(now - 60_000) }, { hash: "b", model: "m", indep: 30 }, now)).toBe(false); // too soon
  expect(shouldRewrite({ ...old, version: PROMPT_VERSION - 1 }, { hash: "b", model: "m", indep: 10 }, now)).toBe(true);
  expect(shouldRewrite(old, { hash: "b", model: "other", indep: 10 }, now)).toBe(true);
});

const cand = (embedKey: string, lede: string, bias: string | null, dist: number, factuality: string | null = null) => ({
  embedKey, domain: embedKey + ".test", outlet: embedKey, sitename: null, title: lede.slice(0, 20), lede, body: lede.repeat(5), bias, factuality, dist,
});
test("summaries: sources are one per independent report and spread across the spectrum", () => {
  const wire = "The Senate on Friday passed a sweeping budget bill after an overnight session that stretched into the morning hours.";
  const picked = pickSources([
    cand("a", wire, "left", 0.1), cand("b", wire, "left", 0.12), cand("c", wire, "left", 0.13),
    cand("d", "Democrats warned of cuts to health programs saying premiums would rise for millions of families next year.", "left", 0.2),
    cand("e", "Republicans praised the measure as a historic tax cut that delivers on a central campaign promise to voters.", "right", 0.3),
    cand("f", "Analysts said markets reacted calmly to the vote, with bond yields little changed in afternoon trading on Friday.", "center", 0.4),
    cand("g", "Local officials in several states described what the budget changes could mean for hospitals and schools soon.", null, 0.5),
  ]);
  expect(picked.length).toBe(4);
  expect(new Set(picked.map((p) => p.lede)).size).toBe(4); // the three wire copies contribute once
  expect(picked.map((p) => p.bias)).toEqual(expect.arrayContaining(["left", "right", "center"]));
});

test("gold: parse, format and score", () => {
  const items = [{ key: "k", headline: "h", titles: ["t"], label: "politics", alt: "business" }];
  expect(parseGold(formatGold(items))).toEqual(items);
  const r = score([
    { label: "politics", predicted: "politics" },
    { label: "politics", alt: "business", predicted: "business" },
    { label: "sports", predicted: "entertainment" },
    { label: "sports", predicted: "sports" },
  ]);
  expect(r).toMatchObject({ n: 4, strict: 0.5, lenient: 0.75 });
  expect(r.confusions).toContainEqual({ gold: "sports", predicted: "entertainment", count: 1 }); // strict: the alt-accepted miss counts too
  expect(r.perTopic.find((p) => p.topic === "sports")).toMatchObject({ support: 2, precision: 1, recall: 0.5 });
});
