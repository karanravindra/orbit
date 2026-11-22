/** Small vector helpers for the clustering code (ported from the archived open-news `core/vec.ts`). */

export const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

export const normalize = (v: Float32Array): Float32Array => {
  const n = Math.sqrt(dot(v, v)) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
};

/** L2-normalised mean direction of `rows`. */
export const centroidOf = (rows: ReadonlyArray<Float32Array>): Float32Array => {
  const c = new Float32Array(rows[0]!.length);
  for (const r of rows) for (let i = 0; i < c.length; i++) c[i]! += r[i]!;
  return normalize(c);
};

/** Running mean: fold one vector into a centroid built from `n` vectors. */
export const addToCentroid = (centroid: Float32Array, n: number, v: Float32Array): Float32Array => {
  const c = new Float32Array(centroid.length);
  for (let i = 0; i < c.length; i++) c[i] = centroid[i]! * n + v[i]!;
  return normalize(c);
};

/** pgvector text format <-> Float32Array. */
export const toPg = (v: Float32Array): string => `[${Array.from(v).join(",")}]`;
export const fromPg = (s: string): Float32Array => Float32Array.from(JSON.parse(s) as number[]);
