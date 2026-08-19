// Rotation, flood guards, redaction, crash capture and the getLogs filters.
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");

const say = console.log.bind(console);
const LIB = path.resolve(__dirname, "..", "dist", "index.js");
const { Log, LogLevel } = require(LIB);

let failures = 0;
const check = (l, ok, x) => { if (!ok) { failures++; say("FAIL " + l + (x ? " :: " + x : "")); } else say("ok   " + l); };
const box = () => fs.mkdtempSync(path.join(os.tmpdir(), "wa-feat-"));
const logFiles = (d) => fs.readdirSync(d).filter(n => n.endsWith(".log")).sort();
const bodyOf = (d) => logFiles(d).map(n => fs.readFileSync(path.join(d, n), "utf8")).join("");
const lineCount = (d) => bodyOf(d).split("\r\n").filter(Boolean).length;

// run a script in its own process, so import-time behaviour is exercised for real
function child(source, env, dir) {
    const home = dir || box();
    const script = path.join(home, "app.js");
    fs.writeFileSync(script, "const LIB = " + JSON.stringify(LIB) + ";\n" + source);
    let out = "", code = 0;
    try {
        out = execFileSync(process.execPath, [script], {
            cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            env: Object.assign({}, process.env, env || {})
        });
    } catch (e) {
        out = (e.stdout || "") + (e.stderr || "");
        code = e.status === null || e.status === undefined ? -1 : e.status;
    }
    return { home: home, out: out, code: code };
}

// ---------------------------------------------------------------- rotation
{
    const dir = box();
    Log.setDir(dir);
    Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
    Log.setRotateSize(4000);

    for (let i = 0; i < 60; i++) Log.info("ROT", "line " + i);
    Log.flush();

    // "2026-08-18.1.log" sorts before "2026-08-18.log", so order by the part number
    const numbered = logFiles(dir)
        .map(n => ({ name: n, part: Number((/^\d{4}-\d{2}-\d{2}(?:\.(\d+))?\.log$/.exec(n) || [])[1] || 0) }))
        .sort((a, b) => a.part - b.part);

    check("rotation opens further parts", numbered.length > 1, numbered.map(f => f.name).join(","));
    check("parts are numbered from the base file up",
        numbered.every((f, i) => f.part === i), numbered.map(f => f.part).join(","));

    const sizes = numbered.map(f => fs.statSync(path.join(dir, f.name)).size);
    // every part but the one still open must be at the limit, give or take a line
    check("closed parts stop at the limit", sizes.slice(0, -1).every(s => s <= 4000 + 1000), sizes.join(","));
    check("the limit is actually being reached", sizes.slice(0, -1).every(s => s > 3000), sizes.join(","));

    const back = Log.getLogs(new Date(Date.now() - 60000), new Date(Date.now() + 60000));
    check("getLogs reads across every part", back.length === 60, back.length + " of 60");
    check("getLogs keeps them in order", back[0].message === "line 0" && back[59].message === "line 59",
        back[0].message + " .. " + back[back.length - 1].message);

    Log.setRotateSize(0);
    fs.rmSync(dir, { recursive: true, force: true });
}

// a restart must continue on the highest part, not overwrite the first one
{
    const dir = box();
    const source = `
        const { Log, LogLevel } = require(LIB);
        Log.setDir(process.env.WA_TARGET);
        Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
        Log.setRotateSize(2000);
        for (let i = 0; i < 40; i++) Log.info("ROT", "run " + process.env.WA_RUN + " line " + i);
    `;
    const target = path.join(dir, "logs");
    child(source, { WA_TARGET: target, WA_RUN: "1" }, dir);
    const afterFirst = logFiles(target).length;
    child(source, { WA_TARGET: target, WA_RUN: "2" }, dir);
    const afterSecond = logFiles(target);

    check("a restart continues on the last part", afterSecond.length >= afterFirst, afterFirst + " then " + afterSecond.length);
    const body = bodyOf(target);
    check("nothing from the first run was overwritten", body.includes("run 1 line 0") && body.includes("run 2 line 0"));
    check("both runs are complete", lineCount(target) === 80, String(lineCount(target)));
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- repeats
{
    const dir = box();
    Log.setDir(dir);
    Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
    Log.setCollapseRepeats(true);

    const parsed = () => bodyOf(dir).split("\r\n").filter(Boolean).map(l => JSON.parse(l));

    for (let i = 0; i < 100; i++) Log.error("LOOP", "the same failure");
    Log.flush();
    let lines = parsed();
    check("a run of 100 becomes 2 lines", lines.length === 2, String(lines.length));
    check("the first occurrence always goes through", lines[0].message === "the same failure", lines[0].message);
    check("flush settles the pending count", lines[1].message === "the same failure (repeated 99 times)", lines[1].message);

    // a different log also closes a run, with no flush involved
    for (let i = 0; i < 10; i++) Log.warn("LOOP", "another failure");
    Log.info("OTHER", "something else");
    Log.flush();
    lines = parsed();
    const at = (m) => lines.findIndex(l => l.message.indexOf(m) >= 0);
    check("a different log closes the run", at("(repeated 9 times)") >= 0, lines.map(l => l.message).join(" | "));
    check("the line that closed it is there too", at("something else") >= 0);
    check("the count is written before it", at("(repeated 9 times)") < at("something else"),
        lines.map(l => l.message).join(" | "));

    Log.setCollapseRepeats(false);
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- rate limit
{
    const dir = box();
    Log.setDir(dir);
    Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
    Log.setRateLimit(5);

    for (let i = 0; i < 200; i++) Log.info("FLOOD", "line " + i);
    Log.flush();

    const body = bodyOf(dir);
    const lines = body.split("\r\n").filter(Boolean).map(l => JSON.parse(l));
    const passed = lines.filter(l => l.name === "FLOOD").length;
    check("the limit holds within a second", passed <= 5, String(passed));
    check("what was dropped is reported", lines.some(l => l.name === "WA-LOG" && /\d+ logs dropped/.test(l.message)),
        lines.map(l => l.name).join(","));
    check("the report says how many", lines.some(l => /19[0-9] logs dropped/.test(l.message)),
        lines.filter(l => l.name === "WA-LOG").map(l => l.message).join(","));

    Log.setRateLimit(0);
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- redaction
{
    const dir = box();
    Log.setDir(dir);
    Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
    Log.setRedact(["password", "Token", "authorization"]);

    let seen = null;
    Log.onEvent("ANY", (l) => { seen = l; });

    const payload = {
        user: "augusto",
        password: "hunter2",
        nested: { token: "abc123", keep: "visible" },
        list: [{ AUTHORIZATION: "Bearer xyz" }, "plain"],
        when: new Date()
    };
    payload.self = payload;
    Log.info("AUTH", "sign in", payload);
    Log.flush();

    const body = bodyOf(dir);
    check("the secret never reaches the file", !body.includes("hunter2") && !body.includes("abc123") && !body.includes("Bearer xyz"), body.slice(0, 200));
    check("the mask is written instead", (body.match(/\[redacted\]/g) || []).length === 3, body);
    check("matching ignores case", !body.includes("Bearer"));
    check("other keys are untouched", body.includes("augusto") && body.includes("visible"));
    check("a circular payload still serializes", body.includes("[Circular]"), body.slice(0, 200));
    check("listeners see the masked copy", seen !== null && seen.object.password === "[redacted]", JSON.stringify(seen && seen.object && seen.object.password));
    check("the caller's own object is left alone", payload.password === "hunter2");

    Log.offEvent("ANY");
    Log.setRedact([]);
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- getLogs filters
{
    const dir = box();
    Log.setDir(dir);
    Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);

    for (let i = 0; i < 20; i++) Log.debug("ALPHA", "debug " + i);
    for (let i = 0; i < 10; i++) Log.warn("BETA", "warn " + i);
    for (let i = 0; i < 5; i++) Log.error("ALPHA", "error " + i);
    // a payload carrying the same shape the name filter looks for
    Log.info("GAMMA", "decoy", { name: "BETA" });
    Log.flush();

    const from = new Date(Date.now() - 60000), to = new Date(Date.now() + 60000);
    check("no filter returns everything", Log.getLogs(from, to).length === 36, String(Log.getLogs(from, to).length));
    check("severity is a floor, not an equality", Log.getLogs(from, to, LogLevel.WARN).length === 15,
        String(Log.getLogs(from, to, LogLevel.WARN).length));
    check("severity TRACE keeps everything", Log.getLogs(from, to, LogLevel.TRACE).length === 36);
    check("name matches exactly", Log.getLogs(from, to, undefined, "ALPHA").length === 25,
        String(Log.getLogs(from, to, undefined, "ALPHA").length));
    check("a name inside the payload is not a match", Log.getLogs(from, to, undefined, "BETA").length === 10,
        String(Log.getLogs(from, to, undefined, "BETA").length));
    check("both filters combine", Log.getLogs(from, to, LogLevel.ERROR, "ALPHA").length === 5,
        String(Log.getLogs(from, to, LogLevel.ERROR, "ALPHA").length));
    check("an unknown name returns nothing", Log.getLogs(from, to, undefined, "NOPE").length === 0);

    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- crash capture
{
    const crash = `
        const { Log } = require(LIB);
        if (process.env.WA_CATCH === "1") Log.setCatchCrashes(true);
        setTimeout(() => { throw new Error("boom from a timer"); }, 1);
    `;

    const off = child(crash, { WA_LOG_DIR: "", WA_CATCH: "0" });
    const offDir = path.join(off.home, "logs");
    check("without it the process still dies", off.code !== 0, "exit " + off.code);
    check("without it nothing is written by us", !fs.existsSync(offDir) || !bodyOf(offDir).includes("boom from a timer"));

    const on = child(crash, { WA_CATCH: "1" });
    const onDir = path.join(on.home, "logs");
    check("with it the crash is logged", fs.existsSync(onDir) && bodyOf(onDir).includes("boom from a timer"),
        fs.existsSync(onDir) ? bodyOf(onDir).slice(0, 160) : "no logs dir");
    check("with it the process still dies", on.code !== 0, "exit " + on.code);
    check("the crash is recorded as FATAL", fs.existsSync(onDir) && bodyOf(onDir).includes('"severity":6'));

    const rejected = child(`
        const { Log } = require(LIB);
        Log.setCatchCrashes(true);
        Promise.reject(new Error("nobody caught this"));
    `, { WA_LOG_CATCH_CRASHES: "false" });
    const rejDir = path.join(rejected.home, "logs");
    check("an unhandled rejection is logged", fs.existsSync(rejDir) && bodyOf(rejDir).includes("nobody caught this"),
        fs.existsSync(rejDir) ? bodyOf(rejDir).slice(0, 160) : "no logs dir");
    check("an unhandled rejection still ends the process", rejected.code !== 0, "exit " + rejected.code);

    // an application handler of its own must keep control
    const shared = child(`
        const { Log } = require(LIB);
        Log.setCatchCrashes(true);
        process.on("uncaughtException", (e) => { console.log("APP HANDLED " + e.message); process.exit(7); });
        setTimeout(() => { throw new Error("shared handling"); }, 1);
    `, {});
    check("an application handler keeps control", shared.out.includes("APP HANDLED shared handling"), shared.out.slice(0, 160));
    check("and its exit code wins", shared.code === 7, "exit " + shared.code);

    for (const r of [off, on, rejected, shared]) fs.rmSync(r.home, { recursive: true, force: true });
}

// the environment switch reaches it too
{
    const envRun = child(`
        const { Log } = require(LIB);
        setTimeout(() => { throw new Error("from the environment"); }, 1);
    `, { WA_LOG_CATCH_CRASHES: "true" });
    const dir = path.join(envRun.home, "logs");
    check("WA_LOG_CATCH_CRASHES installs the handlers", fs.existsSync(dir) && bodyOf(dir).includes("from the environment"),
        fs.existsSync(dir) ? bodyOf(dir).slice(0, 160) : "no logs dir");
    fs.rmSync(envRun.home, { recursive: true, force: true });
}

say(failures === 0 ? "\nALL FEATURE TESTS PASSED" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
