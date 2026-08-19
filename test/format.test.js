const path = require("path");

// Keep a console function that is not captured by wa-log for the test report.
const say = console.log.bind(console);
const { Log, LogLevel } = require(path.resolve(__dirname, "..", "dist", "index.js"));

let failures = 0;
function check(label, ok, extra) {
    if (!ok) { failures++; say("FAIL " + label + (extra ? " :: " + extra : "")); }
    else say("ok   " + label);
}

function capture(run) {
    const write = process.stdout.write.bind(process.stdout);
    let output = "";
    process.stdout.write = (chunk) => { output += chunk; return true; };
    try { run(); } finally { process.stdout.write = write; }
    return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

const base = {
    date: new Date("2026-01-02T03:04:05.006Z"),
    localDate: new Date("2026-01-02T03:04:05.006Z"),
    severity: LogLevel.INFO,
    message: "message",
    object: undefined,
    name: "A",
    local: "a.ts",
    cursor: "1:1",
    stack: []
};

function display(changes) {
    return capture(() => Log.exibir(Object.assign({}, base, changes)));
}

Log.setPathPrint(false);
Log.setFilePrint(false);
Log.setObjectPrint(false);

const shortName = display({ name: "A", message: "short" });
const longName = display({ name: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", message: "long" });
const shortNameAfterGrowth = display({ name: "B", message: "after" });

check("name column starts compact", shortName.includes("INFO  [A] short"), JSON.stringify(shortName));
check("name keeps brackets and truncates at its limit", longName.includes("[ABCDEFGHIJKLMNOPQ…] long"), JSON.stringify(longName));
check("name column grows and keeps alignment", longName.indexOf("long") === shortNameAfterGrowth.indexOf("after"),
    longName.indexOf("long") + " != " + shortNameAfterGrowth.indexOf("after"));

Log.setPathPrint(true);
const shortPath = display({ name: "B", local: "a.ts", cursor: "1:1", message: "short-path" });
const grownPath = display({ name: "B", local: "folder/deeper/file.ts", cursor: "20:3", message: "grown-path" });
const shortPathAfterGrowth = display({ name: "B", local: "b.ts", cursor: "2:1", message: "after-path" });

check("path column starts compact", shortPath.includes("a.ts:1:1 short-path"), JSON.stringify(shortPath));
check("path column grows and keeps alignment", grownPath.indexOf("grown-path") === shortPathAfterGrowth.indexOf("after-path"),
    grownPath.indexOf("grown-path") + " != " + shortPathAfterGrowth.indexOf("after-path"));

const cappedPath = display({ name: "B", local: "/" + "very-long-folder/".repeat(8) + "file.ts", cursor: "99:7", message: "capped" });
check("long path keeps its useful tail", cappedPath.includes("…") && cappedPath.includes("file.ts:99:7 capped"), JSON.stringify(cappedPath));

Log.setPathPrint(false);
Log.setFilePrint(true);
const fileOnly = display({ name: "B", local: "C:\\folder\\file.ts", cursor: "4:2", message: "file-only" });
check("filename has its own compact column", fileOnly.includes("file.ts:4:2 file-only"), JSON.stringify(fileOnly));

Log.setFilePrint(false);
Log.setObjectPrint(true);
const withObject = display({ name: "B", message: "with-object", object: { alpha: "x".repeat(100), nested: { ok: true } } });
const objectLines = withObject.trimEnd().split("\n");
check("object starts on a new indented line", objectLines.length > 1 && objectLines[0].endsWith("with-object") && objectLines[1].startsWith("    └─ "), JSON.stringify(withObject));
check("multiline object keeps its indentation", objectLines.slice(2).every(line => line.startsWith("       ")), JSON.stringify(objectLines));

process.exit(failures === 0 ? 0 : 1);
