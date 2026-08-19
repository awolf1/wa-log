// Runs every suite in its own process: most of what this library does happens at
// import time or on the way out, and neither survives being exercised twice in one
// process. Each one also gets a disposable working directory, because a few of them
// write to the default ./logs on purpose.
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");

const suites = [
    { file: "core.test.js" },
    { file: "format.test.js" },
    { file: "early.test.js" },
    { file: "files.test.js" },
    { file: "purge.test.js" },
    { file: "features.test.js" },
    { file: "memory.test.js", flags: ["--expose-gc"] }
];

const only = process.argv[2];
let failed = 0, total = 0;

for (let i = 0; i < suites.length; i++) {
    const suite = suites[i];
    if (only && suite.file.indexOf(only) < 0) continue;

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-"));
    const started = Date.now();
    const run = spawnSync(process.execPath, (suite.flags || []).concat([path.join(__dirname, suite.file)]), {
        cwd: cwd, encoding: "utf8"
    });
    const out = (run.stdout || "") + (run.stderr || "");
    const checks = (out.match(/^ok {3}/gm) || []).length;
    const ok = run.status === 0;

    total += checks;
    if (!ok) failed++;

    process.stdout.write((ok ? "PASS  " : "FAIL  ") + suite.file.padEnd(20)
        + String(checks).padStart(3) + " checks  " + String(Date.now() - started).padStart(6) + " ms\n");

    if (!ok) {
        const details = out.split("\n").filter(l => /^FAIL|^\s*Error|^\s*at /.test(l)).slice(0, 25);
        process.stdout.write(details.map(l => "        " + l).join("\n") + "\n");
    }

    fs.rmSync(cwd, { recursive: true, force: true });
}

process.stdout.write(failed === 0
    ? "\n" + total + " checks passed\n"
    : "\n" + failed + " suite(s) failed\n");
process.exit(failed === 0 ? 0 : 1);
