// run with --expose-gc
const fs = require("fs"), path = require("path"), os = require("os");
const say = console.log.bind(console);
const { Log, LogLevel } = require(require("path").resolve(__dirname, "..", "dist", "index.js"));

let failures = 0;
const check = (l, ok, x) => { if (!ok) { failures++; say("FAIL " + l + (x ? " :: " + x : "")); } else say("ok   " + l); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-mem-"));
Log.setDir(dir);
Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);   // save everything, print nothing
Log.onEvent("ANY", () => { });

const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const BATCH = 20000, ROUNDS = 8;
const payload = () => ({ user: 42, action: "checkout", items: [1, 2, 3], nested: { a: { b: { c: "deep" } } } });

let round = 0;
const samples = [];

function next() {
    for (let i = 0; i < BATCH; i++) Log.info("SERVICE", "request " + i, payload());
    Log.flush();
    samples.push(heap());
    say("  round " + (++round) + "  heap " + (samples[samples.length - 1] / 1024 / 1024).toFixed(1) + " MB");
    if (round < ROUNDS) return setImmediate(next);
    done();
}

function done() {
    // discard the first two rounds: jit and pool warm-up inflate them
    const settled = samples.slice(2);
    const first = settled[0], last = settled[settled.length - 1];
    const growthMB = (last - first) / 1024 / 1024;
    check("heap flat across " + settled.length + " rounds of " + BATCH + " logs", Math.abs(growthMB) < 8, growthMB.toFixed(1) + " MB drift");

    check("history capped at 100", Log.getLatestLogs().length === 100, String(Log.getLatestLogs().length));

    // the history holds the last 100 payloads by reference, and nothing older
    const held = Log.getLatestLogs();
    check("history holds only the newest entries", held[0].message === "request " + (BATCH - 1) && held[99].message === "request " + (BATCH - 100), held[0].message + " .. " + held[99].message);

    // every line reached the file
    const files = fs.readdirSync(dir);
    const lines = files.reduce((a, f) => a + fs.readFileSync(path.join(dir, f), "utf8").split("\r\n").filter(Boolean).length, 0);
    check("no line lost across " + (BATCH * ROUNDS) + " logs", lines === BATCH * ROUNDS, String(lines));

    // one open handle, not one per write
    let handles = 0;
    try { handles = process._getActiveHandles().length; } catch (e) { }
    check("no handle pile-up", handles < 20, String(handles));

    // listeners can be dropped again
    const removed = Log.offEvent("ANY");
    check("offEvent removes the listener", removed === 1, String(removed));

    fs.rmSync(dir, { recursive: true, force: true });
    say(failures === 0 ? "\nALL MEMORY TESTS PASSED" : "\n" + failures + " FAILURE(S)");
    process.exit(failures === 0 ? 0 : 1);
}

next();
