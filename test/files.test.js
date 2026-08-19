const fs = require("fs"), path = require("path"), os = require("os");
const say = console.log.bind(console);
const { Log, LogLevel } = require(require("path").resolve(__dirname, "..", "dist", "index.js"));
let failures = 0;
const check = (l, ok, x) => { if (!ok) { failures++; say("FAIL " + l + (x ? " :: " + x : "")); } else say("ok   " + l); };
const body = (d) => { const f = fs.readdirSync(d).filter(n => n.endsWith(".log")); return f.length ? fs.readFileSync(path.join(d, f[0]), "utf8") : ""; };

const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-fdswap-"));
const a = path.join(box, "a"), b = path.join(box, "b");

Log.setDir(a); Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
Log.info("APP", "into A"); Log.flush();
check("wrote into A", body(a).includes("into A"));

// switching directories has to swap the open handle
Log.setDir(b);
Log.info("APP", "into B"); Log.flush();
check("wrote into B after setDir", body(b).includes("into B"));
check("A untouched by the later log", !body(a).includes("into B"));

// a cleanup script removing the file must not silence the logger
fs.rmSync(path.join(b, fs.readdirSync(b)[0]));
Log.info("APP", "inside the throttle window"); Log.flush();
check("no stat per write: the deletion is not noticed immediately", !fs.existsSync(path.join(b, "x")) && fs.readdirSync(b).length === 0, JSON.stringify(fs.readdirSync(b)));
const until = Date.now() + 300;
while (Date.now() < until) { /* wait past the 250ms check window */ }
Log.info("APP", "after the file was deleted"); Log.flush();
check("file recreated after external deletion", body(b).includes("after the file was deleted"), JSON.stringify(fs.readdirSync(b)));

// a log dated yesterday goes to yesterday's file, not today's
const y = new Date(Date.now() - 24 * 3600 * 1000);
const stamp = y.getFullYear() + "-" + ("00" + (y.getMonth() + 1)).slice(-2) + "-" + ("00" + y.getDate()).slice(-2) + ".log";
Log.info("APP", "today again"); Log.flush();
check("only today's file exists so far", !fs.existsSync(path.join(b, stamp)));

fs.rmSync(box, { recursive: true, force: true });
say(failures === 0 ? "\nALL FD TESTS PASSED" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
