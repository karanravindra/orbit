import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { CorpusError } from "../errors";
import type { PageImage } from "../parse/Parser";

const CACHE_DIR = new URL("../../data/img-cache", import.meta.url).pathname;
const LONG_EDGE = 1568;

export interface Page {
  /** "recipe_28" */
  readonly id: string;
  readonly n: number;
  readonly png: string;
  /** Rough typed transcription next to the photo, if there is one. Only a hint. */
  readonly hint: string | null;
}

const fail = (message: string) => (cause: unknown) => new CorpusError({ message, cause });

/** Every `recipe_N.png` in `dir`, in numeric order, paired with its `recipe_N.md` hint. */
export const listPages = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const names = await readdir(dir);
      const pages: Page[] = [];
      for (const name of names) {
        const m = /^recipe_(\d+)\.png$/.exec(name);
        if (!m) continue;
        const id = `recipe_${m[1]}`;
        const md = Bun.file(join(dir, `${id}.md`));
        pages.push({ id, n: Number(m[1]), png: join(dir, name), hint: (await md.exists()) ? await md.text() : null });
      }
      return pages.sort((a, b) => a.n - b.n);
    },
    catch: fail(`Can't read ${dir}`),
  });

/** Downscale the 4032x3024 original to a ~1568px JPEG (cached) and return it base64-encoded. macOS `sips`. */
export const loadImage = (page: Page) =>
  Effect.tryPromise({
    try: async (): Promise<PageImage> => {
      await mkdir(CACHE_DIR, { recursive: true });
      const out = join(CACHE_DIR, `${page.id}.jpg`);
      if (!(await Bun.file(out).exists())) {
        const proc = Bun.spawn(["sips", "-Z", String(LONG_EDGE), "-s", "format", "jpeg", "-s", "formatOptions", "85", page.png, "--out", out], {
          stdout: "ignore",
          stderr: "pipe",
        });
        if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
      }
      return { base64: Buffer.from(await Bun.file(out).arrayBuffer()).toString("base64"), mediaType: "image/jpeg" };
    },
    catch: fail(`Can't prepare image for ${page.id}`),
  });

/** Distinct bullet lines from every markdown hint in `dir`: input for the ingredient seed pass. */
export const ingredientLines = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const seen = new Map<string, string>();
      // Sorted so the spelling kept for a duplicate line doesn't depend on directory order.
      for (const name of (await readdir(dir)).sort()) {
        if (!name.endsWith(".md")) continue;
        for (const line of (await Bun.file(join(dir, name)).text()).split("\n")) {
          const m = /^\s*[-*]\s+(.+)$/.exec(line);
          if (!m) continue;
          const text = m[1]!.trim();
          const key = text.toLowerCase();
          if (!seen.has(key)) seen.set(key, text);
        }
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b));
    },
    catch: fail(`Can't read ingredient lines from ${dir}`),
  });
