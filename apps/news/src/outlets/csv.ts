import { isBias, type Bias } from "./bias";

export interface OutletRow {
  readonly domain: string;
  readonly name: string;
  readonly bias: Bias;
  readonly factuality: "high" | "mixed" | "low" | null;
  readonly country: string | null;
}

/** Split one CSV line, honouring double quotes ("" escapes a quote). */
export const splitLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") (out.push(cur), (cur = ""));
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

export const normaliseDomain = (d: string): string => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/** Parse `domain,name,bias,factuality,country` (header required). Bad rows are returned, not thrown. */
export const parseOutlets = (text: string): { rows: OutletRow[]; errors: string[] } => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = splitLine(lines.shift() ?? "").map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [d, n, b, f, c] = ["domain", "name", "bias", "factuality", "country"].map(col) as [number, number, number, number, number];
  const rows = new Map<string, OutletRow>();
  const errors: string[] = [];
  if (d < 0 || n < 0 || b < 0) return { rows: [], errors: ["header must include domain, name, bias"] };
  lines.forEach((line, i) => {
    const cells = splitLine(line);
    const domain = normaliseDomain(cells[d] ?? "");
    const bias = (cells[b] ?? "").toLowerCase();
    const fact = f >= 0 ? (cells[f] ?? "").toLowerCase() : "";
    if (!domain || !domain.includes(".")) return void errors.push(`line ${i + 2}: bad domain "${cells[d] ?? ""}"`);
    if (!isBias(bias)) return void errors.push(`line ${i + 2}: bad bias "${cells[b] ?? ""}" for ${domain}`);
    rows.set(domain, {
      domain,
      name: cells[n] || domain,
      bias,
      factuality: fact === "high" || fact === "mixed" || fact === "low" ? fact : null,
      country: (c >= 0 ? cells[c] : "") || null,
    });
  });
  return { rows: [...rows.values()], errors };
};
