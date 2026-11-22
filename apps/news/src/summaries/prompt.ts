/**
 * Summary prompt and output checks. Prompt = the winner of bench/summarize (gemma4:e2b, "rules" system prompt,
 * paragraph format: faithfulness 4.7/5, 94% format-compliant, ~2 s). Pure, so it is unit-tested without a model.
 */
export const PROMPT_VERSION = 1;
export const MAX_WORDS = 70;

export interface SourceText {
  readonly outlet: string;
  readonly title: string;
  readonly text: string;
}

export const SYSTEM = `You are a news summarizer for a news feed. Rules:
- Use ONLY facts stated in the provided text. Never add outside knowledge, guesses, or background.
- Keep names, numbers, places and dates exactly as written.
- Lead with the most important fact: who did what, and the key outcome.
- Neutral tone. No opinions, no adjectives not in the text.
- When the sources disagree on a fact, state both versions briefly.
- Output ONLY the summary in the requested format: no preface, no title, no "Here is", no commentary.`;

const FORMAT = "a short paragraph of 2-3 sentences, at most 60 words in total.";

export const sourceBlock = (sources: ReadonlyArray<SourceText>): string =>
  sources.length === 1
    ? `Title: ${sources[0]!.title}\n\n${sources[0]!.text}`
    : sources.map((s, i) => `[Source ${i + 1}: ${s.outlet}]\nTitle: ${s.title}\n\n${s.text}`).join("\n\n");

export const messagesFor = (sources: ReadonlyArray<SourceText>) => {
  const noun = sources.length === 1 ? "news article" : "news story (several articles about the same event)";
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Summarize the ${noun} below in ${FORMAT}\n\n<text>\n${sourceBlock(sources)}\n</text>` },
  ];
};

const PREFACE = /^(?:here(?:'s| is)|summary:|the (?:news )?(?:story|article|text) (?:is about|describes|reports))/i;
const numbers = (s: string) => (s.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, ""));

/** Reasons a generated summary should not be shown. null = acceptable. Numbers must appear in the sources (small models invent figures). */
export const checkSummary = (summary: string, sources: ReadonlyArray<SourceText>): string | null => {
  const s = summary.trim();
  if (s.length < 40) return "too short";
  const words = s.split(/\s+/).length;
  if (words > MAX_WORDS) return `too long (${words} words)`;
  if (PREFACE.test(s)) return "has a preface";
  if (/^[-*•]\s|\n[-*•]\s/.test(s)) return "is a list";
  const hay = sourceBlock(sources).replace(/,/g, "");
  const ungrounded = numbers(s).filter((n) => !hay.includes(n));
  return ungrounded.length > 0 ? `ungrounded number ${ungrounded[0]}` : null;
};

/** Zero-compute stand-in shown until the model has written one: the first sentences of the most central report's lede. */
export const extractive = (lede: string | null, max = 280): string | null => {
  if (!lede) return null;
  const sentences = lede.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [lede];
  let out = "";
  for (const s of sentences) {
    if (out && out.length + s.length > max) break;
    out += s;
  }
  return (out || lede).trim().slice(0, max);
};
