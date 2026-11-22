/** Article extraction with Bun's built-in HTMLRewriter (no DOM, no Readability). */
import { Effect } from "effect";
import { ExtractError } from "../errors";
import { lowQuality, type LowQuality } from "./quality";

export interface Extracted {
  readonly title: string | null;
  readonly sitename: string | null;
  readonly publishedAt: Date | null;
  readonly lede: string;
  readonly body: string;
  /** Absolute http(s) URL of the page's social-share image (og:image / twitter:image), if any. */
  readonly imageUrl: string | null;
  readonly titleKey: string | null;
  readonly textHash: string | null;
  /** null = usable article */
  readonly rejectReason: "short" | "non_english" | LowQuality | null;
}

const MIN_BODY_CHARS = 500;
const MIN_PARAGRAPH_CHARS = 40;
const LEDE_CHARS = 600;
const SKIP = "nav, footer, aside, form, figure, header, script, style, noscript, template";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

/** HTMLRewriter hands us raw text, entities and all. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/**
 * Paywall, cookie and sign-up banners that sit in ordinary <p> tags. Left in, they become the "lede", poison the
 * embedding text (every paywalled article of one site shares it) and show up as the summary in the UI.
 */
const BOILERPLATE = new RegExp(
  [
    "you have reached your maximum number",
    "you(?:'|’)ve used all of your gift articles",
    "(?:subscribe|sign in|log in|register) to (?:continue|keep|read|unlock)",
    "already a (?:subscriber|member)",
    "this (?:content|article|story) is (?:only )?(?:available )?for (?:subscribers|members)",
    "create a free account to",
    "to continue reading",
    "we use cookies",
    "accept (?:all )?cookies",
    "enable javascript",
    "your browser (?:is not supported|does not support)",
    "all rights reserved",
  ].join("|"),
  "i",
);
export const isBoilerplate = (p: string): boolean => BOILERPLATE.test(p);

/** First clean paragraph of a stored body, for display when the stored lede is boilerplate. */
export const cleanLede = (lede: string | null, body: string | null, max = 320): string | null => {
  if (lede && !isBoilerplate(lede)) return lede.slice(0, max);
  const para = (body ?? "").split(/\n\n+/).find((p) => p.length >= MIN_PARAGRAPH_CHARS && !isBoilerplate(p));
  return para ? para.slice(0, max) : null;
};

const absoluteImage = (raw: string | undefined, base: string | undefined): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

export const titleKey = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function run(html: Uint8Array, baseUrl?: string): Promise<Extracted> {
  const meta: Record<string, string> = {};
  let lang: string | null = null;
  let titleTag = "";
  let skipDepth = 0;
  let cur: string | null = null;
  const paragraphs: string[] = [];

  const rewriter = new HTMLRewriter()
    .on("html", { element: (el) => void (lang = el.getAttribute("lang")) })
    .on("title", { text: (t) => void (titleTag += t.text) })
    .on("meta", {
      element(el) {
        const key = (el.getAttribute("property") ?? el.getAttribute("name"))?.toLowerCase();
        const content = el.getAttribute("content");
        if (key && content && !(key in meta)) meta[key] = content;
      },
    })
    .on(SKIP, {
      element(el) {
        skipDepth++;
        el.onEndTag(() => void skipDepth--);
      },
    })
    .on("p", {
      element(el) {
        if (skipDepth > 0) return;
        cur = "";
        el.onEndTag(() => {
          const p = squash(cur ?? "");
          cur = null;
          if (p.length >= MIN_PARAGRAPH_CHARS && !isBoilerplate(p)) paragraphs.push(p);
        });
      },
      text: (t) => void (cur !== null && (cur += t.text)),
    });

  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html" } })).text(); // drain so handlers run

  const title = squash(meta["og:title"] ?? meta["twitter:title"] ?? titleTag) || null;
  const body = paragraphs.join("\n\n");
  let lede = "";
  for (const p of paragraphs) {
    if (lede.length >= LEDE_CHARS) break;
    lede += (lede ? " " : "") + p;
  }
  lede = lede.slice(0, LEDE_CHARS);

  const published = meta["article:published_time"] ?? meta["og:article:published_time"];
  const publishedAt = published && !Number.isNaN(Date.parse(published)) ? new Date(published) : null;

  const host = (() => {
    try {
      return baseUrl ? new URL(baseUrl).hostname : null;
    } catch {
      return null;
    }
  })();
  const rejectReason =
    lang && !/^en\b/i.test(lang) ? "non_english" : body.length < MIN_BODY_CHARS || !title ? "short" : lowQuality(title, lede, host);

  return {
    title,
    sitename: meta["og:site_name"] ? squash(meta["og:site_name"]) : null,
    publishedAt,
    lede,
    body,
    imageUrl: absoluteImage(meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? meta["twitter:image:src"], baseUrl),
    titleKey: title ? titleKey(title) : null,
    textHash: body ? new Bun.CryptoHasher("sha1").update(body).digest("hex") : null,
    rejectReason,
  };
}

export const extract = (html: Uint8Array, baseUrl?: string): Effect.Effect<Extracted, ExtractError> =>
  Effect.tryPromise({
    try: () => run(html, baseUrl),
    catch: (cause) => new ExtractError({ message: "HTML extraction failed", cause }),
  }).pipe(Effect.withSpan("extract"));
