import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the regression gate the way a developer does, on a vitest JSON report.
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const script = join(repoRoot, "tests/__baseline__/verify-no-regression.mjs");
const dir = mkdtempSync(join(tmpdir(), "vnr-"));

// Two entries that are in known-fails.txt: one failing test, one suite that cannot load.
const KNOWN_FILE = "tests/unit/combo-autoswitch.test.js";
const KNOWN_TEST = "detectRequiredCapabilities web_search tool -> search";
const KNOWN_SUITE = "tests/unit/db-benchmark.test.js";

function report(root, extra = []) {
  return {
    testResults: [
      { name: `${root}/${KNOWN_FILE}`, status: "failed", assertionResults: [
        { fullName: KNOWN_TEST, status: "failed" },
        { fullName: "reorderByCapabilities passes now", status: "passed" },
      ] },
      { name: `${root}/${KNOWN_SUITE}`, status: "failed", message: "Failed to load", assertionResults: [] },
      ...extra,
    ],
  };
}

function gate(name, results) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(results));
  const run = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  return { code: run.status, out: run.stdout + run.stderr };
}

const newFailure = (root) => ({ name: `${root}/tests/unit/new.test.js`, status: "failed", assertionResults: [{ fullName: "new behavior breaks", status: "failed" }] });
const brokenSuite = (root) => ({ name: `${root}/tests/unit/broken-import.test.js`, status: "failed", message: "Cannot find module", assertionResults: [] });

describe("verify-no-regression gate", () => {
  // This checkout, the Docker image's /app, and a committed report from another machine.
  for (const [layout, root] of [["this checkout", repoRoot], ["Docker /app", "/app"], ["another machine", "/Users/someone/work/9router"]]) {
    it(`passes when every failure is a known failure (${layout})`, () => {
      const { code, out } = gate(`known-${layout.replace(/\W/g, "")}`, report(root));
      expect(out).toContain("No regression");
      expect(out).toContain("now fails=2");
      expect(code).toBe(0);
    });

    it(`fails and names a newly failing test (${layout})`, () => {
      const { code, out } = gate(`new-${layout.replace(/\W/g, "")}`, report(root, [newFailure(root)]));
      expect(code).toBe(1);
      expect(out).toContain("tests/unit/new.test.js :: new behavior breaks");
      expect(out).not.toContain("undefined");
    });
  }

  it("fails when a suite that used to load no longer loads", () => {
    const { code, out } = gate("broken-suite", report(repoRoot, [brokenSuite(repoRoot)]));
    expect(code).toBe(1);
    expect(out).toContain("tests/unit/broken-import.test.js :: <suite failed to load>");
  });
});
