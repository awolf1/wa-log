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
        // read right after the log call, before the background pass had a chance to run
        console.log("INLINE=" + require("fs").readdirSync(${JSON.stringify(dir)}).sort().join(","));
    `);
    const out = execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, { WA_LOG_DIR: dir, WA_LOG_PURGE_DAYS: "2" })
    });
    const inline = (out.match(/INLINE=(.*)/) || [])[1].split(",").filter(Boolean);
    check("the first write does not purge inline", inline.includes(dayName(3)) && inline.includes(dayName(400)), inline.join(","));
    // read once the process is gone: nobody awaited the pass, it still finished first
    const left = names(dir);
    check("WA_LOG_PURGE_DAYS applied in the background before exit", !left.includes(dayName(3)) && !left.includes(dayName(400)), left.join(","));
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
    `);
    execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, { WA_LOG_DIR: dir, WA_LOG_PURGE_SIZE: "8KB" })
    });
    const left = names(dir);
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

// run a script in its own process and hand back the directory it logged into
function child(source, env) {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-purge-"));
    const dir = path.join(box, "logs");
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, "const { Log, LogLevel } = require(" + JSON.stringify(LIB) + ");\n" + source);
    execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, { WA_LOG_DIR: dir }, env || {})
    });
    return { box: box, dir: dir };
}

// logs 200 lines over several ticks, the way a running service does, then exits on its own
const burst = `
    Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
    Log.setRotateSize(2000);
    let i = 0;
    (function batch() {
        for (let k = 0; k < 20; k++, i++) Log.info("ROT", "line " + i);
        if (i < 200) setTimeout(batch, 1);
    })();
`;
const partOf = (n) => Number((/^\d{4}-\d{2}-\d{2}(?:\.(\d+))?\.log$/.exec(n) || [])[1] || 0);
const sizeOf = (d) => names(d).reduce((t, n) => t + fs.statSync(path.join(d, n)).size, 0);

(async () => {

    // 9. by count, oldest first, the current file counting toward the limit
    {
        const dir = fresh([0, 1, 2, 3, 4, 5]);
        Log.setDir(dir);
        const removed = Log.setPurgeFiles(3);
        const left = names(dir);
        check("count rule deletes down to the limit", removed === 3, "removed " + removed);
        check("count rule keeps the newest, today included",
            left.join(",") === [dayName(2), dayName(1), dayName(0)].sort().join(","), left.join(","));
        Log.setPurgeFiles(0);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 10. purgeAsync leaves the calling tick alone, and a call during a pass joins it
    {
        const back = [];
        for (let i = 1; i <= 200; i++) back.push(i);
        const dir = fresh(back);
        const idle = fs.mkdtempSync(path.join(os.tmpdir(), "wa-purge-"));
        // the rule is set while pointing elsewhere, so its immediate pass finds nothing
        Log.setDir(idle);
        Log.setPurgeDays(7);
        Log.setDir(dir);

        const first = Log.purgeAsync();
        const inline = names(dir).length;
        const second = Log.purgeAsync();
        check("purgeAsync deletes nothing inline", inline === 200, inline + " of 200");
        check("a call during a pass joins it", first === second);

        const removed = await first;
        check("purgeAsync resolves with the files it removed", removed === 194, "removed " + removed);
        check("purgeAsync applies the rule", names(dir).length === 6, names(dir).join(","));

        // a file that shows up while a pass runs is caught by the pass the late call asked for
        const third = Log.purgeAsync();
        fs.writeFileSync(path.join(dir, dayName(30)), "late");
        await Log.purgeAsync();
        await third;
        check("a late call is covered by one more pass", !names(dir).includes(dayName(30)), names(dir).join(","));

        Log.setPurgeDays(0);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(idle, { recursive: true, force: true });
    }

    // 11. purgeAsync never rejects, not even on a directory that vanished
    {
        const gone = path.join(os.tmpdir(), "wa-purge-gone-async-" + process.pid);
        Log.setDir(gone);
        Log.setPurgeDays(1);
        fs.rmSync(gone, { recursive: true, force: true });
        let result;
        try { result = await Log.purgeAsync(); } catch (e) { result = "threw " + e; }
        check("purgeAsync survives a vanished directory", result === 0, String(result));
        Log.setPurgeDays(0);
    }

    // 12. a new part re-applies the size rule during the day, not only at midnight
    {
        const run = child(burst + `Log.setPurgeSize(6000);`);
        const left = names(run.dir);
        check("rotation keeps the directory within the size budget", sizeOf(run.dir) <= 6000, sizeOf(run.dir) + " bytes, " + left.length + " files");
        const last = left.slice().sort((a, b) => partOf(a) - partOf(b)).pop();
        check("the part being written survives the purge",
            fs.readFileSync(path.join(run.dir, last), "utf8").includes('"line 199"'), last);
        fs.rmSync(run.box, { recursive: true, force: true });
    }

    // 13. the count rule from the environment, applied as parts are opened
    {
        const run = child(burst, { WA_LOG_PURGE_FILES: "3" });
        const left = names(run.dir);
        check("WA_LOG_PURGE_FILES caps the number of parts", left.length === 3, left.join(","));
        const parts = left.map(partOf).sort((a, b) => a - b);
        check("the newest parts are the ones kept", parts[2] - parts[0] === 2 && parts[0] > 0, parts.join(","));
        const last = left.slice().sort((a, b) => partOf(a) - partOf(b)).pop();
        check("the newest part holds the last line",
            fs.readFileSync(path.join(run.dir, last), "utf8").includes('"line 199"'), last);
        fs.rmSync(run.box, { recursive: true, force: true });
    }

    say(failures === 0 ? "\nALL PURGE TESTS PASSED" : "\n" + failures + " FAILURE(S)");
    process.exit(failures === 0 ? 0 : 1);
})();
