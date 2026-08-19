// Each case runs in its own child process: the behaviour under test happens at
// import time, so it cannot be exercised twice inside one process.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// forward slashes: this path is pasted into the source of the child scripts below
const LIB = require("path").resolve(__dirname, "..", "dist", "index.js").replace(/\\/g, "/");
let failures = 0;

function check(label, ok, extra) {
    if (!ok) { failures++; console.log("FAIL " + label + (extra ? " :: " + extra : "")); }
    else console.log("ok   " + label);
}

function run(body, env) {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-early-"));
    const script = path.join(box, "app.js");
    const target = path.join(box, "target");
    fs.writeFileSync(script, body.replace(/__TARGET__/g, target.replace(/\\/g, "\\\\")).replace(/__LIB__/g, LIB));
    let stdout = "";
    try {
        stdout = execFileSync(process.execPath, [script], {
            cwd: box,
            env: Object.assign({}, process.env, env || {}),
            encoding: "utf8"
        });
    } catch (e) {
        stdout = (e.stdout || "") + (e.stderr || "");
    }
    const readDir = (d) => fs.existsSync(d)
        ? fs.readdirSync(d).filter(f => fs.statSync(path.join(d, f)).isFile()).map(f => fs.readFileSync(path.join(d, f), "utf8")).join("")
        : null;
    return { box: box, stdout: stdout, target: readDir(target), fallback: readDir(path.join(box, "logs")) };
}

// 1. the reported case: a module logs while it loads, main calls setDir afterwards
let r = run(`
    const { Log, LogLevel } = require("__LIB__");
    Log.setLevel(LogLevel.TRACE, LogLevel.TRACE);
    // stands for a dependency that logs while the application is still loading
    console.log("early from a module");
    Log.info("BOOT", "early from wa-log");
    // only now the application knows where the logs belong
    Log.setDir("__TARGET__");
    Log.info("APP", "after setDir");
`);
check("early log reached the configured dir", !!r.target && r.target.includes("early from a module") && r.target.includes("early from wa-log"), r.target ? "missing" : "no target dir");
check("nothing left behind in the default dir", r.fallback === null, r.fallback);
check("later log also in the configured dir", !!r.target && r.target.includes("after setDir"));

// 2. setDir on a directory that does not exist yet
r = run(`
    const { Log, LogLevel } = require("__LIB__");
    Log.setLevel(LogLevel.TRACE, LogLevel.TRACE);
    console.log("created dir:", Log.setDir("__TARGET__/deep/deeper"));
    Log.info("APP", "into a fresh tree");
`);
check("setDir creates a missing tree", r.stdout.includes("created dir: true"), r.stdout.trim().split("\n").pop());
check("log written into the fresh tree", fs.existsSync(path.join(r.box, "target", "deep", "deeper")) && fs.readdirSync(path.join(r.box, "target", "deep", "deeper")).length === 1);

// 3. WA_LOG_DIR: no setDir call at all
// the target path is only known after run() creates the box, so do it by hand
{
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-early-"));
    const target = path.join(box, "envdir");
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, `
        const { Log } = require(${JSON.stringify(LIB)});
        Log.info("APP", "straight to the env dir");
        console.log("shown?");
    `);
    const out = execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, {
            WA_LOG_DIR: target,
            WA_LOG_LEVEL_SAVE: "TRACE",
            WA_LOG_LEVEL_SHOW: "FATAL",
            WA_LOG_CONSOLE: "false"
        })
    });
    const files = fs.existsSync(target) ? fs.readdirSync(target) : [];
    check("WA_LOG_DIR used without any setDir call", files.length === 1, JSON.stringify(files));
    check("WA_LOG_LEVEL_SAVE honoured", files.length === 1 && fs.readFileSync(path.join(target, files[0]), "utf8").includes("straight to the env dir"));
    check("WA_LOG_LEVEL_SHOW=FATAL silences the info line", !out.includes("straight to the env dir"), JSON.stringify(out));
    check("WA_LOG_CONSOLE=false silences the captured console.log", !out.includes("shown?"), JSON.stringify(out));
    check("no default logs dir created", !fs.existsSync(path.join(box, "logs")));
}

// 4. an explicit setter still beats the environment
{
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-early-"));
    const envDir = path.join(box, "fromenv");
    const codeDir = path.join(box, "fromcode");
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, `
        const { Log, LogLevel } = require(${JSON.stringify(LIB)});
        Log.setDir(${JSON.stringify(codeDir)});
        Log.setLevel(LogLevel.TRACE, LogLevel.TRACE);
        Log.info("APP", "code wins");
    `);
    execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, { WA_LOG_DIR: envDir, WA_LOG_LEVEL_SAVE: "TRACE" })
    });
    check("setDir overrides WA_LOG_DIR", fs.existsSync(codeDir) && fs.readdirSync(codeDir).length === 1);
}

// 5. invalid values are ignored, never fatal
{
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-early-"));
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, `
        const { Log } = require(${JSON.stringify(LIB)});
        Log.info("APP", "still alive");
        console.log("survived");
    `);
    const out = execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, {
            WA_LOG_LEVEL_SHOW: "banana", WA_LOG_LEVEL_SAVE: "99",
            WA_LOG_CONSOLE: "maybe", WA_LOG_DIR: "   "
        })
    });
    check("garbage in the environment is ignored", out.includes("survived") && out.includes("still alive"), JSON.stringify(out.slice(0, 120)));
}

// 6. the buffer cannot grow without bound when setDir never comes
{
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-early-"));
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, `
        const { Log, LogLevel } = require(${JSON.stringify(LIB)});
        Log.setLevel(LogLevel.FATAL, LogLevel.TRACE);
        // 5000 lines in one tick, no setDir anywhere
        for (let i = 0; i < 5000; i++) Log.info("APP", "line " + i);
        const held = require("util").inspect(process.memoryUsage().heapUsed);
        setImmediate(() => {
            const fs = require("fs");
            const dir = require("path").resolve("logs");
            const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
            const body = files.length ? fs.readFileSync(require("path").join(dir, files[0]), "utf8") : "";
            console.log("LINES=" + body.trim().split("\\r\\n").filter(Boolean).length);
        });
    `);
    const out = execFileSync(process.execPath, [script], { cwd: box, encoding: "utf8" });
    const written = Number((out.match(/LINES=(\d+)/) || [])[1] || 0);
    check("buffer never stalls: everything landed in the default dir", written === 5000, "wrote " + written);
}

// 7. a process that exits in the same tick still writes its logs
{
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "wa-early-"));
    const target = path.join(box, "exitdir");
    const script = path.join(box, "app.js");
    fs.writeFileSync(script, `
        const { Log, LogLevel } = require(${JSON.stringify(LIB)});
        Log.setLevel(LogLevel.TRACE, LogLevel.TRACE);
        Log.fatal("APP", "last words");
        process.exit(0);
    `);
    execFileSync(process.execPath, [script], {
        cwd: box, encoding: "utf8",
        env: Object.assign({}, process.env, { WA_LOG_DIR: target })
    });
    const files = fs.existsSync(target) ? fs.readdirSync(target) : [];
    check("logs survive an immediate process.exit", files.length === 1 && fs.readFileSync(path.join(target, files[0]), "utf8").includes("last words"), JSON.stringify(files));
}

console.log(failures === 0 ? "\nALL EARLY-LOG TESTS PASSED" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
