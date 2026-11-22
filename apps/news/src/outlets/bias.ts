export const BIASES = ["left", "lean-left", "center", "lean-right", "right"] as const;
export type Bias = (typeof BIASES)[number];
export type Side = "left" | "center" | "right";

export const isBias = (s: string): s is Bias => (BIASES as ReadonlyArray<string>).includes(s);
export const sideOf = (b: Bias): Side => (b === "left" || b === "lean-left" ? "left" : b === "right" || b === "lean-right" ? "right" : "center");

/** Distinct outlets per bias bucket; `unrated` outlets have no rating. */
export interface BiasCounts {
  readonly left: number;
  readonly leanLeft: number;
  readonly center: number;
  readonly leanRight: number;
  readonly right: number;
  readonly unrated: number;
}

export const rated = (c: BiasCounts): number => c.left + c.leanLeft + c.center + c.leanRight + c.right;

/** Share of rated outlets per side, 0..1 (all zero when nothing is rated). */
export const sideShares = (c: BiasCounts): Record<Side, number> => {
  const n = rated(c);
  return n === 0 ? { left: 0, center: 0, right: 0 } : { left: (c.left + c.leanLeft) / n, center: c.center / n, right: (c.right + c.leanRight) / n };
};

/**
 * A blindspot is a story one side of the spectrum mostly ignores: with enough rated outlets, the named side
 * is the under-represented one (<= `maxShare` of rated outlets) while the opposite side holds >= `minOpposite`.
 */
export const blindspot = (c: BiasCounts, opts = { minRated: 4, maxShare: 0.1, minOpposite: 0.6 }): "left" | "right" | null => {
  if (rated(c) < opts.minRated) return null;
  const s = sideShares(c);
  if (s.left <= opts.maxShare && s.right >= opts.minOpposite) return "left";
  if (s.right <= opts.maxShare && s.left >= opts.minOpposite) return "right";
  return null;
};
