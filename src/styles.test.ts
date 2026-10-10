// Vitest executes this regression check in Node; the browser app intentionally omits Node typings.
// @ts-expect-error Node's built-in module is available in the test runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("BCS table text containment", () => {
  it("keeps long selected values inside their cells", () => {
    expect(styles).toMatch(
      /\.bcs-editor-table \.custom-select-trigger > span\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.bcs-editor-table \.custom-select-trigger\s*\{[^}]*overflow:\s*hidden;[^}]*\}/s,
    );
  });
});
