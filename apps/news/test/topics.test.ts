import { expect, test } from "bun:test";
import { promptFor } from "../src/topics/Classifier";
import { TOPICS, TOPIC_IDS, isTopic } from "../src/topics/taxonomy";

test("taxonomy: ids are unique, lowercase, and recognised", () => {
  expect(new Set(TOPIC_IDS).size).toBe(TOPICS.length);
  for (const id of TOPIC_IDS) expect(id).toMatch(/^[a-z]+$/);
  expect(isTopic("politics")).toBe(true);
  expect(isTopic("Politics")).toBe(false);
  expect(isTopic("nonsense")).toBe(false);
});

test("prompt: headline first, other coverage listed only when there is some", () => {
  expect(promptFor("A", [])).toBe("Headline: A\n\nWhich section?");
  expect(promptFor("A", ["B", "C"])).toBe("Headline: A\nOther coverage:\n- B\n- C\n\nWhich section?");
});
