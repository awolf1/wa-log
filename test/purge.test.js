const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");
const say = console.log.bind(console);
// forward slashes: this path is pasted into the source of the child scripts below
const LIB = require("path").resolve(__dirname, "..", "dist", "index.js").replace(/\\/g, "/");
const { Log, LogLevel } = require(LIB);

let failures = 0;
const check = (l, ok, x) => { if (!ok) { failures++; say("FAIL " + l + (x ? " :: " + x : "")); } else say("ok   " + l); };

const dayName = (back) => {
    const d = new Date();
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    return t.getFullYear() + "-" + ("00" + (t.getMonth() + 1)).slice(-2) + "-" + ("00" + t.getDate()).slice(-2) + ".log";
};

function fresh(days, bytesPerFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-purge-"));
    for (const back of days) fs.writeFileSync(path.join(dir, dayName(back)), "x".repeat(bytesPerFile || 100));
    return dir;
}
const names = (d) => fs.readdirSync(d).sort();

// 1. off by default
{
    const dir = fresh([0, 1, 30, 400]);
    Log.setDir(dir);
    Log.setPurgeDays(0); Log.setPurgeSize(0);
    check("purge is off by default", Log.purge() === 0 && names(dir).length === 4, names(dir).join(","));
    fs.rmSync(dir, { recursive: true, force: true });
}

// 2. by age
{
    const dir = fresh([0, 1, 2, 6, 7, 8, 100]);
    Log.setDir(dir);
    const removed = Log.setPurgeDays(7);
    const left = names(dir);
    check("age rule deletes the older files", removed === 3, "removed " + removed);
    check("age rule keeps 7 days, today included", left.length === 4 && left.includes(dayName(0)) && left.includes(dayName(6)), left.join(","));
    check("age rule dropped day 7 and beyond", !left.includes(dayName(7)) && !left.includes(dayName(8)) && !left.includes(dayName(100)), left.join(","));
    Log.setPurgeDays(0);
    fs.rmSync(dir, { recursive: true, force: true });
}

// 3. today's file is never touched, whatever the rules say
{
    const dir = fresh([0], 5000);
    Log.setDir(dir);
    const removed = Log.setPurgeDays(1) + Log.setPurgeSize(10);
    check("the current day is never deleted", removed === 0 && names(dir).length === 1, names(dir).join(","));
    Log.setPurgeDays(0); Log.setPurgeSize(0);
    fs.rmSync(dir, { recursive: true, force: true });
}

// 4. by total size, oldest first
{
    const dir = fresh([0, 1, 2, 3], 1000);   // 4 KB in the directory
    Log.setDir(dir);
    const removed = Log.setPurgeSize(2500);
    const left = names(dir);
    check("size rule deletes until it fits", removed === 2, "removed " + removed);
    check("size rule keeps the newest", left.includes(dayName(0)) && left.includes(dayName(1)), left.join(","));
    check("size rule dropped the oldest", !left.includes(dayName(3)) && !left.includes(dayName(2)), left.join(","));
    Log.setPurgeSize(0);
    fs.rmSync(dir, { recursive: true, force: true });
}

// 5. nothing that is not ours is ever deleted
{
    const dir = fresh([1, 2, 500]);
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
    fs.writeFileSync(path.join(dir, "app.log"), "keep me too");            // .log, but not a date
    fs.writeFileSync(path.join(dir, "2026-13-45.log"), "impossible date");
    fs.writeFileSync(path.join(dir, "backup-2020-01-01.log"), "prefixed");
    fs.mkdirSync(path.join(dir, "2020-01-01.log"));                        // a directory wearing the name
    Log.setDir(dir);
    Log.setPurgeDays(1);
    const left = names(dir);
    check("plain files survive", left.includes("notes.txt") && left.includes("app.log"));
    check("impossible dates survive", left.includes("2026-13-45.log"), left.join(","));
    check("prefixed names survive", left.includes("backup-2020-01-01.log"), left.join(","));
    check("a directory named like a log file survives", left.includes("2020-01-01.log"), left.join(","));
    check("only the real old logs went", !left.includes(dayName(500)) && !left.includes(dayName(2)), left.join(","));
    Log.setPurgeDays(0);
    fs.rmSync(dir, { recursive: true, force: true });
}

// 6. logging keeps working right after a purge, and the purge runs on the first write
{
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-purge-"));
    const dir = path.join(box, "logs");
    fs.mkdirSync(dir);
    for (const back of [1, 2, 3, 400]) fs.writeFileSync(path.join(dir, dayName(back)), "old\r\n");
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, `
        const { Log, LogLevel } = require(${JSON.stringify(LIB)});
        Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
        Log.info("APP", "first line of the day");
        Log.flush();
        console.log("FILES=" + require("fs").readdirSync(${JSON.stringify(dir)}).sort().join(","));
    `);
    const out = execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, { WA_LOG_DIR: dir, WA_LOG_PURGE_DAYS: "2" })
    });
    const left = (out.match(/FILES=(.*)/) || [])[1].split(",").filter(Boolean);
    check("WA_LOG_PURGE_DAYS applied on the first write", !left.includes(dayName(3)) && !left.includes(dayName(400)), left.join(","));
    check("inside the window kept", left.includes(dayName(1)), left.join(","));
    check("today's file was written after the purge", left.includes(dayName(0)) && fs.readFileSync(path.join(dir, dayName(0)), "utf8").includes("first line of the day"));
    fs.rmSync(box, { recursive: true, force: true });
}

// 7. size from the environment, with a suffix
{
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-purge-"));
    const dir = path.join(box, "logs");
    fs.mkdirSync(dir);
    for (const back of [1, 2, 3]) fs.writeFileSync(path.join(dir, dayName(back)), "x".repeat(4096));
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, `
        const { Log, LogLevel } = require(${JSON.stringify(LIB)});
        Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
        Log.info("APP", "hello");
        Log.flush();
        console.log("FILES=" + require("fs").readdirSync(${JSON.stringify(dir)}).sort().join(","));
    `);
    const out = execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, { WA_LOG_DIR: dir, WA_LOG_PURGE_SIZE: "8KB" })
    });
    const left = (out.match(/FILES=(.*)/) || [])[1].split(",").filter(Boolean);
    check("WA_LOG_PURGE_SIZE understands a suffix", !left.includes(dayName(3)), left.join(","));
    check("size rule stops once it fits", left.includes(dayName(1)), left.join(","));
    fs.rmSync(box, { recursive: true, force: true });
}

// 8. a missing directory is not a crash
{
    Log.setDir(path.join(os.tmpdir(), "wa-purge-gone-" + process.pid));
    fs.rmSync(path.join(os.tmpdir(), "wa-purge-gone-" + process.pid), { recursive: true, force: true });
    let threw = false;
    try { Log.setPurgeDays(1); Log.purge(); } catch (e) { threw = true; }
    check("a vanished directory is survivable", !threw);
    Log.setPurgeDays(0);
}

say(failures === 0 ? "\nALL PURGE TESTS PASSED" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
