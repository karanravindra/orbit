import { expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeEntities, extract } from "../src/extract/extract";

const para = (s: string) => `<p>${s} ${"filler words to make this long enough. ".repeat(4)}</p>`;
const page = (body: string, lang = "en") =>
  new TextEncoder().encode(`<html lang="${lang}"><head><title>T &amp; co</title>
<meta property="og:title" content="Big &amp; Bold: Senate votes"><meta property="og:site_name" content="The Daily">
<meta property="article:published_time" content="2025-11-19T10:00:00Z"></head><body>${body}</body></html>`);
const run = (html: Uint8Array) => Effect.runPromise(extract(html));

test("extracts title, meta and paragraphs, skipping nav/footer", async () => {
  const x = await run(page(`<nav><p>${"menu ".repeat(20)}</p></nav>${para("Senate passed it &quot;today&quot;.")}${para("Second")}${para("Third")}${para("Fourth")}<footer><p>${"legal ".repeat(20)}</p></footer>`));
  expect(x.title).toBe("Big & Bold: Senate votes");
  expect(x.sitename).toBe("The Daily");
  expect(x.publishedAt?.toISOString()).toBe("2025-11-19T10:00:00.000Z");
  expect(x.body).toContain('Senate passed it "today".');
  expect(x.body).not.toContain("menu");
  expect(x.body).not.toContain("legal");
  expect(x.rejectReason).toBeNull();
  expect(x.lede.length).toBeLessThanOrEqual(600);
  expect(x.textHash).toHaveLength(40);
});

test("rejects short and non-English pages", async () => {
  expect((await run(page(para("tiny")))).rejectReason).toBe("short");
  expect((await run(page(para("a").repeat(8), "fr"))).rejectReason).toBe("non_english");
});

test("decodeEntities", () => {
  expect(decodeEntities("a &amp; b &#39;c&#x27; &nbsp;d &unknown;")).toBe("a & b 'c'  d &unknown;");
});
