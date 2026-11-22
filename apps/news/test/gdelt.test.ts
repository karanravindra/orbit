import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { floorSlice, parseLastUpdate, parseSlice, sliceUrl } from "../src/gdelt/parse";

const row = (collection: string, url: string, extras = "") => {
  const c = Array(27).fill("");
  c[1] = "20251119213000";
  c[2] = collection;
  c[4] = url;
  c[26] = extras;
  return c.join("\t");
};

test("parseSlice keeps web rows, reads title hint", () => {
  const tsv = [row("1", "https://a.com/x", "<PAGE_TITLE>Hello</PAGE_TITLE>"), row("2", "https://jstor.org/y"), row("1", "ftp://bad")].join("\n");
  const rows = parseSlice(zipSync({ "x.gkg.csv": strToU8(tsv) }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ url: "https://a.com/x", titleHint: "Hello" });
  expect(rows[0]!.seen.toISOString()).toBe("2025-11-19T21:30:00.000Z");
});

test("parseLastUpdate + sliceUrl + floorSlice", () => {
  const txt = "1 a http://data.gdeltproject.org/gdeltv2/20251119213000.export.CSV.zip\n3 c http://data.gdeltproject.org/gdeltv2/20251119213000.gkg.csv.zip\n";
  const ts = parseLastUpdate(txt);
  expect(sliceUrl(ts)).toBe("https://data.gdeltproject.org/gdeltv2/20251119213000.gkg.csv.zip");
  expect(floorSlice(new Date("2025-11-19T21:44:59Z")).toISOString()).toBe("2025-11-19T21:30:00.000Z");
});
