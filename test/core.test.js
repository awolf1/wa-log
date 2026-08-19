const os = require("os");
const fs = require("fs");
const path = require("path");

// grabbed before the library wraps the console, so the assertions never feed themselves back in
const say = console.log.bind(console);
const here = require("path").basename(__filename);

const { Log, LogLevel } = require(require("path").resolve(__dirname, "..", "dist", "index.js"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-log-smoke-"));
const nested = path.join(dir, "a", "b");
fs.mkdirSync(nested, { recursive: true });

let failures = 0;
function check(label, ok, extra) {
    if (!ok) { failures++; say("FAIL " + label + (extra ? " :: " + extra : "")); }
    else say("ok   " + label);
}

check("setDir nested", Log.setDir(nested) === true);
Log.setLevel(LogLevel.TRACE, LogLevel.TRACE);
Log.setObjectPrint(true);

let seen = 0;
Log.onEvent("ANY", () => { seen++; });

// 1. plain log
Log.info("APP", "hello");
let last = Log.getLastLog();
check("getLastLog message", last.message === "hello", JSON.stringify(last.message));
check("local resolved (windows stack)", typeof last.local === "string" && last.local.includes(here), last.local + ":" + last.cursor);
check("cursor resolved", /^\d+:\d+$/.test(last.cursor), last.cursor);

// 2. circular / bigint / function payload must not drop the line
const circular = { name: "root" };
circular.self = circular;
circular.big = 10n;
circular.fn = function noop() { };
Log.warn("APP", "circular", circular);

// 3. non-Error throws
try { throw "just a string"; } catch (e) { Log.catch(e, LogLevel.ERROR); }
last = Log.getLastLog();
check("catch(string) name", last.name === "NonError", last.name);
check("catch(string) message", last.message === "just a string", last.message);
check("catch(string) points at the caller", last.local.includes(here), last.local + ":" + last.cursor);

try { throw { code: 42 }; } catch (e) { Log.catch(e); }
last = Log.getLastLog();
check("catch(object) message", last.message === '{"code":42}', last.message);
check("catch(object) points at the caller", last.local.includes(here), last.local);

try { null.boom(); } catch (e) { Log.catch(e, LogLevel.FATAL); }
last = Log.getLastLog();
check("catch(Error) name", last.name === "TypeError", last.name);
check("catch(Error) local is a file, not the header", !last.local.startsWith("TypeError") && last.local.includes(here), last.local);

// 4. missing stack must not crash
const noStack = new Error("no stack here");
noStack.stack = undefined;
Log.catch(noStack);
last = Log.getLastLog();
check("catch without stack", last.message === "no stack here", last.message);

// 5. terminal escape injection stripped from console output (the lib writes through the native console)
const write = process.stdout.write.bind(process.stdout);
let printed = "";
process.stdout.write = (chunk, ...rest) => { printed += chunk; return true; };
Log.error("A\u001b[2J", "wipe\u001b[1;31m screen");
process.stdout.write = write;
check("ANSI stripped from name/message", printed.length > 0 && !printed.includes("[2J") && !printed.includes("[1;31m"), JSON.stringify(printed.slice(0, 160)));
check("payload text kept", printed.includes("wipe") && printed.includes("screen"), JSON.stringify(printed.slice(0, 160)));
check("severity colours kept", printed.includes("\u001b[41m"), "no bg colour");

// 6. opt-out still available
Log.setSanitizePrint(false);
printed = "";
process.stdout.write = (chunk, ...rest) => { printed += chunk; return true; };
Log.error("APP", "raw\u001b[1;31m escape");
process.stdout.write = write;
check("setSanitizePrint(false) keeps raw content", printed.includes("\u001b[1;31m"));
Log.setSanitizePrint(true);

// 7. getLatestLogs returns a copy
const copy = Log.getLatestLogs();
copy.length = 0;
check("getLatestLogs is a copy", Log.getLatestLogs().length > 0);

// 8. console capture still feeds the pipeline
const before = seen;
console.log("captured by wa-log");
last = Log.getLastLog();
check("console.log captured", seen > before);
check("console message stored", last.message === "captured by wa-log", last.message);
check("console call located", last.local.includes(here), last.local);

// 9. files on disk
setTimeout(() => {
    const files = fs.readdirSync(nested);
    check("log file written", files.length === 1 && files[0].endsWith(".log"), files.join(","));
    const body = fs.readFileSync(path.join(nested, files[0]), "utf8");
    const lines = body.trim().split("\r\n");
    const parsed = lines.map(l => JSON.parse(l));
    check("every line is valid JSON", parsed.length === lines.length, lines.length + " lines");
    const circ = parsed.find(p => p.message === "circular");
    check("circular object persisted", !!circ && circ.object.self === "[Circular]" && circ.object.big === "10" && !("fn" in circ.object), JSON.stringify(circ && circ.object));
    check("ESC escaped inside the json file", !body.includes("\u001b"));

    const found = Log.getLogs(new Date(Date.now() - 60000), new Date(Date.now() + 60000));
    check("getLogs reads back", found.length === parsed.length, found.length + " vs " + parsed.length);

    fs.writeFileSync(path.join(nested, "notes.txt"), "not a log\n");
    check("non .log files ignored", Log.getLogs(new Date(Date.now() - 60000), new Date(Date.now() + 60000)).length === found.length);

    fs.rmSync(dir, { recursive: true, force: true });
    say(failures === 0 ? "\nALL SMOKE TESTS PASSED" : "\n" + failures + " FAILURE(S)");
    process.exit(failures === 0 ? 0 : 1);
}, 300);
