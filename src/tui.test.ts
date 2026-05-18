import { expect, test } from "bun:test";
import { addSection, clearSections, getSectionCount, shortPath } from "./tui.js";

test("shortPath trims the repo root", () => {
  expect(shortPath("/root/deepseek-full-api/pi-harness/src/tui.ts")).toBe("~/pi-harness/src/tui.ts");
});

test("section state can be cleared and rebuilt", () => {
  clearSections();
  expect(getSectionCount()).toBe(0);

  const idx = addSection("Title", "Detail", "cyan", false);
  expect(idx).toBe(0);
  expect(getSectionCount()).toBe(1);

  clearSections();
  expect(getSectionCount()).toBe(0);
});
