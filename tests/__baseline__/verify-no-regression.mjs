// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { relative, resolve, sep } from "path";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"))
);

// known-fails.txt names files from the repo root ("tests/unit/x.test.js"). A report made
// in this checkout is relative to it; one made elsewhere (Docker's /app, another machine)
// is cut at its last "/tests/" segment.
function repoPath(file) {
  const rel = relative(REPO_ROOT, file);
  if (!rel.startsWith("..") && !rel.startsWith(sep)) return rel.split(sep).join("/");
  const posix = file.split("\\").join("/");
  const at = posix.lastIndexOf("/tests/");
  return at === -1 ? posix : posix.slice(at + 1);
}

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const nowFails = r.testResults.flatMap(f => {
  const file = repoPath(f.name);
  const failed = f.assertionResults.filter(a => a.status === "failed").map(a => `${file} :: ${a.fullName}`);
  // A suite that cannot load has no assertion results; count it, or a broken import passes.
  if (failed.length === 0 && f.status === "failed") return [`${file} :: <suite failed to load>`];
  return failed;
});

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
