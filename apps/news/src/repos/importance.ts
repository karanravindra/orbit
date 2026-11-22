const HOUR = 3_600_000;
const HALF_LIFE_H = 12; // a story loses half its freshness weight every 12 h without new coverage

export interface ImportanceInput {
  readonly outlets: number; // distinct owner groups
  readonly texts: number; // distinct texts
  readonly articles: number;
  /** Articles first seen in the last few hours. */
  readonly recent: number;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
}

/**
 * Front-page rank. Breadth (how many independent outlets, how many distinct writeups) sets the base, freshness decays
 * it, and momentum (share of coverage that arrived in the last hours) lifts stories that are still growing.
 * `breaking` = young, widely covered, and most of its coverage is recent.
 */
export const importance = (s: ImportanceInput, now: number = Date.now()) => {
  const breadth = Math.log1p(s.outlets) + 0.5 * Math.log1p(s.texts);
  const idleH = Math.max(0, (now - +s.lastSeen) / HOUR);
  const fresh = 0.5 ** (idleH / HALF_LIFE_H);
  const momentum = s.articles > 0 ? Math.min(1, s.recent / s.articles) : 0;
  const ageH = Math.max(0, (now - +s.firstSeen) / HOUR);
  const score = breadth * (0.35 + 0.65 * fresh) * (1 + 0.5 * momentum);
  const breaking = ageH <= 8 && s.outlets >= 8 && momentum >= 0.5 && idleH <= 2;
  return { score: Math.round(score * 1000) / 1000, breaking };
};
