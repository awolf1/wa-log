import path from "path";
import fs from 'fs';
import { inspect } from "util";


/**
 * Numeric log severity, ordered from the least to the most severe.
 * A configured threshold includes that level and every level above it.
 *
 * - `TRACE` (0): detailed internal state and execution flow
 * - `DEBUG` (1): development and diagnostic information
 * - `LOG` (2): generic application output
 * - `INFO` (3): normal operational events
 * - `WARN` (4): unexpected but recoverable situations
 * - `ERROR` (5): failed operations or requests
 * - `FATAL` (6): failures that compromise or terminate the process
 */
enum LogLevel {
    TRACE,
    DEBUG,
    LOG,
    INFO,
    WARN,
    ERROR,
    FATAL
}


/** A structured log record produced by the logger. */
interface LogData {
    /** Actual instant when the record was created. */
    date: Date;
    /** Timezone-adjusted value used to render local wall-clock time. */
    localDate: Date;
    /** Numeric severity assigned to the record. */
    severity: LogLevel;
    /** Human-readable event or error description. */
    message: string;
    /** Optional structured context associated with the record. */
    object: any;
    /** Short category, component, or error name. */
    name: string;
    /** Source file path inferred from the captured stack. */
    local: string;
    /** Source line and column in `line:column` form. */
    cursor: string;
    /** Captured diagnostic stack frames. */
    stack: Array<string>;
}


//const LogEmitter = new EventEmitter();

/**
 * Static logging API with colored console output, JSON Lines persistence, an
 * in-memory history, event listeners, and automatic capture of `console.*` calls.
 *
 * @example
 * ```ts
 * Log.info("API", "Server started", { port: 3000 });
 * Log.error("DB", "Query failed", { queryId: "q-17" });
 * ```
 */
class Log {

    private static levelShow = LogLevel.INFO;
    private static levelSave = LogLevel.TRACE;

    private static ignoreLog = false;

    private static dir = path.resolve("logs");
    private static latestLogs: Array<LogData> = new Array();

    private static consolePrint = true;
    private static pathPrint = true;
    private static filePrint = true;
    private static objectPrint = false;

    // Console columns grow with the content seen by this process, but never far
    // enough for a long label or path to push the message out of sight.
    private static nameColumnWidth = 0;
    private static pathColumnWidth = 0;
    private static fileColumnWidth = 0;
    private static readonly NAME_COLUMN_MAX = 20;
    private static readonly PATH_COLUMN_MAX = 80;
    private static readonly FILE_COLUMN_MAX = 30;

    // Kept on globalThis so a second copy of wa-log inside node_modules still
    // reaches the real console instead of the wrappers installed by the first copy.
    private static nativeConsole: any = Log.captureNativeConsole();

    private static _trace = Log.nativeConsole.trace;
    private static _debug = Log.nativeConsole.debug;
    private static _log = Log.nativeConsole.log;
    private static _info = Log.nativeConsole.info;
    private static _warning = Log.nativeConsole.warn;
    private static _error = Log.nativeConsole.error;

    private static sanitizePrint = true;
    private static stackDepth: number = null;

    // Nothing reaches the disk until the destination directory is settled, otherwise
    // every log fired while the application modules load lands in the default dir.
    // The wait is bounded twice over: setDir() flushes, and so does the end of the
    // current tick, so the buffer can never outlive one tick even if setDir never comes.
    private static pending: Array<LogData> = [];
    private static dirSettled = false;
    private static flushScheduled = false;
    private static readonly PENDING_MAX = 500;

    // Lines wait here for the end of the tick and then go out in a single append.
    // One append per tick instead of one per log keeps the file in order, keeps the
    // handle count at one, and leaves something that can be written synchronously
    // when the process goes down.
    private static queue: Array<{ file: string, line: string }> = [];
    private static queueBytes = 0;
    private static writeScheduled = false;
    // a count would say nothing about memory when a single payload is large
    private static readonly QUEUE_MAX_BYTES = 1024 * 1024;

    // The handle stays open between writes. Opening and closing a file costs around
    // 12 ms on Windows against 5 us for a write on an open handle, and that is the
    // whole reason a synchronous write is affordable here.
    private static fd: number = null;
    private static fdFile: string = null;
    private static fdCheckedAt = 0;
    private static readonly FD_CHECK_MS = 250;

    private static filePath: string = null;
    private static fileDay: string = null;
    private static fileDir: string = null;
    private static filePart = 0;
    private static fdBytes = 0;
    private static rotateBytes = 0;

    // Both off by default: deleting somebody's logs is never a default.
    private static purgeDays = 0;
    private static purgeBytes = 0;

    // Flood guards, both off by default: they change what ends up in the file.
    private static collapseRepeats = false;
    private static rateLimit = 0;

    private static repeatKey: string = null;
    private static repeatCount = 0;
    private static repeatSample: LogData = null;

    private static rateSecond = 0;
    private static rateCount = 0;
    private static rateDropped = 0;

    private static redactKeys: Array<string> = [];

    // Off by default: installing these handlers changes how the process behaves,
    // not only what it records, so it has to be asked for.
    private static catchCrashes = false;

    private static calls = new Array();

    //#################################################################### Public - setter

    /**
     * Enables or disables the full source path and line/column in console output.
     * Full-path output takes precedence over filename-only output.
     * @param print Whether to print the full source path.
     */
    public static setPathPrint(print: boolean) {
        Log.pathPrint = print;
    }

    /**
     * Enables or disables filename and line/column output when full-path output is off.
     * @param print Whether to print only the source filename.
     */
    public static setFilePrint(print: boolean) {
        Log.filePrint = print;
    }

    /**
     * Controls whether captured `console.*` calls also pass through to the native
     * console. Their structured log records are still processed normally.
     * @param print Whether to preserve the original native console call.
     */
    public static setConsolePrint(print: boolean) {
        Log.consolePrint = print;
    }

    /**
     * Enables or disables payload display in the console. This does not affect the
     * payload stored in files, history, or event callbacks.
     * @param print Whether to print the payload on a separate indented line.
     */
    public static setObjectPrint(print: boolean) {
        Log.objectPrint = print;
    }

    /**
     * How many stack frames a log keeps beyond the call site. Formatting a frame costs
     * around 2.5 us, which makes this the strongest speed lever in the library: going
     * from the 6 frames of the default down to 1 nearly halves the cost of a log.
     * @param frames Frames to keep, 1 or more. Any other value restores the runtime default.
     */
    public static setStackDepth(frames: number) {
        Log.stackDepth = (typeof frames === "number" && frames >= 1) ? Math.floor(frames) : null;
    }

    /**
     * Controls whether control characters, including ANSI escapes, are stripped
     * before names and messages reach the console. Keep this enabled so untrusted
     * content cannot repaint the terminal or forge log lines.
     * @param sanitize Whether to strip control characters. Defaults to `true`.
     */
    public static setSanitizePrint(sanitize: boolean) {
        Log.sanitizePrint = sanitize;
    }

    /**
     * Logs an uncaught exception or unhandled rejection as `FATAL` before the process
     * exits. Disabled by default: a listener on those events is what stops Node from
     * ending the process, so this library installs one only when asked, and still
     * ends the process itself unless the application is handling the event too.
     * @param enabled Whether to install the crash handlers.
     * @returns Whether the crash handlers are enabled.
     */
    public static setCatchCrashes(enabled: boolean): boolean {
        if (typeof process === "undefined" || !process || typeof process.on !== "function") return false;

        // removing first keeps a second call from stacking another pair of handlers
        process.removeListener("uncaughtException", Log.onUncaught);
        process.removeListener("unhandledRejection", Log.onRejection);

        Log.catchCrashes = enabled === true;
        if (Log.catchCrashes) {
            process.on("uncaughtException", Log.onUncaught);
            process.on("unhandledRejection", Log.onRejection);
        }
        return Log.catchCrashes;
    }

    /**
     * Folds a message repeated back to back into a single record carrying the count,
     * so a failure inside a loop cannot fill the disk. The first occurrence always
     * goes through; the count arrives when a different log shows up, on flush, or
     * when the process ends. Off by default.
     * @param collapse Whether to fold consecutive duplicate records.
     */
    public static setCollapseRepeats(collapse: boolean) {
        Log.collapseRepeats = collapse === true;
        if (!Log.collapseRepeats) Log.flushRepeats();
    }

    /**
     * Accepts at most this many records per second and counts the rest, reporting how many
     * were dropped once the second is over. 0, the default, accepts everything.
     * @param perSecond Maximum accepted records per second. Use `0` to disable the limit.
     */
    public static setRateLimit(perSecond: number) {
        Log.rateLimit = (typeof perSecond === "number" && perSecond > 0) ? Math.floor(perSecond) : 0;
        if (Log.rateLimit <= 0) Log.flushDropped();
    }

    /**
     * Masks the value of these keys inside the payload, up to eight levels deep.
     * Matching ignores case. An empty list, the default, masks nothing. A password
     * written to a log file outlives the request that leaked it.
     * @param keys Key names to mask, for example `password`, `token`, and `authorization`.
     */
    public static setRedact(keys: Array<string>) {
        Log.redactKeys = Array.isArray(keys)
            ? keys.filter((k: any) => typeof k === "string" && k.length > 0).map((k: string) => k.toLowerCase())
            : [];
    }

    /**
     * Starts a new file once the current one reaches this size, named
     * `YYYY-MM-DD.1.log`, `.2.log` and so on. 0, the default, keeps one file per day
     * however large it gets. A restart continues on the highest part already on disk.
     * @param bytes Maximum part size in bytes. Use `0` to disable rotation.
     */
    public static setRotateSize(bytes: number) {
        Log.rotateBytes = (typeof bytes === "number" && bytes > 0) ? Math.floor(bytes) : 0;
        // the day is re-resolved on the next write, picking the right part up again
        Log.fileDay = null;
    }

    /**
     * Keeps this many days of log files, including today, and deletes older files.
     * 0, the default, keeps everything. Only files this library wrote are ever
     * touched, and never the current one.
     * @param days Number of days to retain, including today. Use `0` to disable this rule.
     * @returns Number of files removed by the immediate retention pass.
     */
    public static setPurgeDays(days: number): number {
        Log.purgeDays = (typeof days === "number" && days > 0) ? Math.floor(days) : 0;
        return Log.purge();
    }

    /**
     * Keeps the log directory under this many bytes, deleting the oldest files first.
     * 0, the default, keeps everything. The file being written is never deleted,
     * so the directory can still exceed the limit when a single day does.
     * @param bytes Size budget for the entire log directory. Use `0` to disable this rule.
     * @returns Number of files removed by the immediate retention pass.
     */
    public static setPurgeSize(bytes: number): number {
        Log.purgeBytes = (typeof bytes === "number" && bytes > 0) ? Math.floor(bytes) : 0;
        return Log.purge();
    }

    /**
     * Sets independent minimum severity levels for console display and file storage.
     * Records below both thresholds still remain available in memory and to listeners.
     * @param show Minimum console severity. Defaults to `INFO`.
     * @param save Minimum file severity. Defaults to `TRACE`.
     */
    public static setLevel(show: LogLevel, save: LogLevel) {
        Log.levelShow = show;
        Log.levelSave = save;
    }

    /**
     * Creates and selects the directory used for log files.
     * Falls back to `./logs` when the destination cannot be created or is not a directory.
     * @param dir Directory path, resolved from the current working directory when relative.
     * @returns Whether the requested directory was selected successfully.
     */
    public static setDir(dir: string): boolean {
        try {
            dir = path.resolve(dir);
            if (!fs.existsSync(dir)) {
                // mode: log payloads carry application data, keep them owner-only (no-op on Windows).
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
            if (fs.lstatSync(dir).isDirectory()) {
                Log.dir = dir;
                Log.flush();
                return true;
            } else {
                Log.dir = path.resolve("logs");
                return false;
            }
        } catch (e) {
            Log.dir = path.resolve("logs");
            return false;
        }
    }

    /**
     * Writes every log line still held in memory. On return, the lines are on disk.
     * Runs on its own at the end of the tick, on setDir and on process exit, so
     * calling it by hand is only needed before reading the files by other means.
     */
    public static flush() {
        Log.flushRepeats();
        Log.flushDropped();
        Log.release();
        Log.drain();
    }

    /** Moves the lines held while the directory was unsettled into the write queue. */
    private static release() {
        Log.dirSettled = true;
        Log.flushScheduled = false;
        const buffered = Log.pending;
        Log.pending = [];
        for (let i = 0; i < buffered.length; i++) {
            Log.write(buffered[i]);
        }
    }


    //#################################################################### Public - getter

    /**
     * Returns the most recently generated record from memory.
     * @returns The latest record, or `undefined` at runtime before the first log.
     */
    public static getLastLog(): LogData {
        return Log.latestLogs[0];
    }
    /**
     * Returns a shallow copy of the in-memory history, newest first.
     * @returns Up to 100 recent records.
     */
    public static getLatestLogs(): Array<LogData> {
        return Log.latestLogs.slice();
    }
    /**
     * Reads persisted logs between two inclusive dates.
     * @param start Inclusive beginning of the time range.
     * @param end Inclusive end of the time range.
     * @param severity Optional minimum severity; `WARN` also includes `ERROR` and `FATAL`.
     * @param name Optional exact, case-sensitive log name.
     * @returns Matching records read from the persisted JSON Lines files.
     */
    public static getLogs(start: Date, end: Date, severity?: LogLevel, name?: string): Array<LogData> {
        let ret: Array<LogData> = [];
        Log.flush();
        if (fs.existsSync(Log.dir)) {
            let s = Log.dayOf(start);
            let e = Log.dayOf(end);

            // sorted, because a day can span several parts and they must read in order
            let files = fs.readdirSync(Log.dir)
                .map((name: string) => ({ name: name, parsed: Log.parseLogName(name) }))
                .filter((f: any) => f.parsed !== null && f.parsed.day >= s && f.parsed.day <= e)
                .sort((a: any, b: any) => (a.parsed.day - b.parsed.day) || (a.parsed.part - b.parsed.part))
                .map((f: any) => f.name);

            const floor = (typeof severity === "number") ? severity : null;
            const wanted = (typeof name === "string" && name.length > 0) ? name : null;
            // a name is a substring of the line long before it is a parsed field, and
            // skipping the parse is most of the work when filtering a large file
            const needle = wanted === null ? null : '"name":' + JSON.stringify(wanted);

            for (let i = 0; i < files.length; i++) {
                // read as text, not as a Buffer turned into text, and walked with
                // indexOf: an array holding every line would cost as much memory
                // again as the file itself
                const body = fs.readFileSync(path.resolve(Log.dir, files[i]), "utf8");
                let at = 0;
                while (at < body.length) {
                    let stop = body.indexOf("\n", at);
                    if (stop < 0) stop = body.length;

                    const raw = body.slice(at, stop);
                    at = stop + 1;
                    if (raw.length === 0) continue;
                    if (needle !== null && raw.indexOf(needle) < 0) continue;

                    try {
                        let line = JSON.parse(raw);
                        if (floor !== null && !(line.severity >= floor)) continue;
                        if (wanted !== null && line.name !== wanted) continue;

                        let ld = new Date(line.date);
                        if (ld >= start && ld <= end) {
                            ret.push(line);
                        }
                    } catch (e) {

                    }
                }
            }
        }
        return ret;
    }

    //#################################################################### Public - logs

    /**
     * Logs an exception or any other thrown value. `Error` instances keep their
     * original name, message, and stack; other values are recorded as `NonError`.
     * @param error The caught value.
     * @param severity Severity assigned to the record. Defaults to `INFO`.
     * @param object Optional structured context associated with the failure.
     * @example
     * ```ts
     * try {
     *     await runTask();
     * } catch (error: unknown) {
     *     Log.catch(error, LogLevel.ERROR, { taskId: "task-42" });
     * }
     * ```
     */
    public static catch(error: unknown, severity?: LogLevel, object?: any) {
        if (severity == null) {
            severity = LogLevel.INFO;
        }

        // A `catch (e)` binding is `unknown` under modern TypeScript, and throwing a
        // string or a plain object is common, so nothing here may assume an Error.
        const isError = error instanceof Error;
        const name: string = isError ? (error as Error).name : "NonError";
        const message: string = isError ? (error as Error).message : Log.describe(error);
        const raw: string = isError ? (error as Error).stack : undefined;

        let stack: Array<string> = (typeof raw === "string" && raw.length > 0)
            ? raw.split("\n")
            // 3 frames to skip: the Error header, getErrorObject and catch itself.
            : Log.stackLines(Log.getErrorObject(), 3);

        for (let i = 0; i < stack.length; i++) {
            // Windows stacks carry backslashes, so matching only "/" never sliced off the header.
            if (stack[i].includes(":") && /[\\/]/.test(stack[i])) {
                stack = stack.slice(i);
                break;
            }
        }

        const frame = Log.parseFrame(stack[0] ?? "unknown");
        const local: string = frame.local;
        const cursor: string = frame.cursor;

        const d = new Date();
        let ld: LogData = {
            date: d,
            localDate: new Date(d.getTime() - d.getTimezoneOffset() * 60000),
            severity: severity,
            name: name,
            message: message,
            object: object,
            local: local,
            cursor: cursor,
            stack: stack.map((s: string) => s.trim())
        };
        Log.run(ld);
    }

    /**
     * Creates a `TRACE` (0) record.
     * @param name Short category or component name.
     * @param message Human-readable event description.
     * @param object Optional structured context.
     */
    public static trace(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.TRACE, name, message, object));
    }

    /**
     * Creates a `DEBUG` (1) record.
     * @param name Short category or component name.
     * @param message Human-readable event description.
     * @param object Optional structured context.
     */
    public static debug(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.DEBUG, name, message, object));
    }

    /**
     * Creates a generic `LOG` (2) record.
     * @param name Short category or component name.
     * @param message Human-readable event description.
     * @param object Optional structured context.
     */
    public static log(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.LOG, name, message, object));
    }

    /**
     * Creates an `INFO` (3) record.
     * @param name Short category or component name.
     * @param message Human-readable event description.
     * @param object Optional structured context.
     */
    public static info(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.INFO, name, message, object));
    }

    /**
     * Creates a `WARN` (4) record.
     * @param name Short category or component name.
     * @param message Human-readable event description.
     * @param object Optional structured context.
     */
    public static warn(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.WARN, name, message, object));
    }

    /**
     * Creates an `ERROR` (5) record.
     * @param name Short category or component name.
     * @param message Human-readable event description.
     * @param object Optional structured context.
     */
    public static error(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.ERROR, name, message, object));
    }

    /**
     * Creates a `FATAL` (6) record.
     * @param name Short category or component name.
     * @param message Human-readable event description.
     * @param object Optional structured context.
     */
    public static fatal(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.FATAL, name, message, object));
    }


    //#################################################################### Protected - init

    /**
     * Reads the WA_LOG_* variables. It runs at import time, which is the only moment
     * early enough to catch what the application modules log while they load.
     * Every value is a default: an explicit setter called later still wins, and an
     * unreadable or invalid value is ignored instead of throwing.
     */
    protected static _initEnv() {
        const env: any = (typeof process !== "undefined" && process && process.env) ? process.env : null;
        if (!env) return;

        const show = Log.parseLevel(env.WA_LOG_LEVEL_SHOW);
        if (show != null) Log.levelShow = show;

        const save = Log.parseLevel(env.WA_LOG_LEVEL_SAVE);
        if (save != null) Log.levelSave = save;

        const consolePrint = Log.parseBool(env.WA_LOG_CONSOLE);
        if (consolePrint != null) Log.consolePrint = consolePrint;

        const pathPrint = Log.parseBool(env.WA_LOG_PATH_PRINT);
        if (pathPrint != null) Log.pathPrint = pathPrint;

        const filePrint = Log.parseBool(env.WA_LOG_FILE_PRINT);
        if (filePrint != null) Log.filePrint = filePrint;

        const objectPrint = Log.parseBool(env.WA_LOG_OBJECT_PRINT);
        if (objectPrint != null) Log.objectPrint = objectPrint;

        const sanitize = Log.parseBool(env.WA_LOG_SANITIZE);
        if (sanitize != null) Log.sanitizePrint = sanitize;

        const depth = Number(env.WA_LOG_STACK_DEPTH);
        if (Number.isInteger(depth) && depth >= 1) Log.stackDepth = depth;

        const days = Number(env.WA_LOG_PURGE_DAYS);
        if (Number.isInteger(days) && days > 0) Log.purgeDays = days;

        const size = Log.parseSize(env.WA_LOG_PURGE_SIZE);
        if (size != null) Log.purgeBytes = size;

        const rotate = Log.parseSize(env.WA_LOG_ROTATE_SIZE);
        if (rotate != null) Log.rotateBytes = rotate;

        const crashes = Log.parseBool(env.WA_LOG_CATCH_CRASHES);
        if (crashes != null) Log.setCatchCrashes(crashes);

        const collapse = Log.parseBool(env.WA_LOG_COLLAPSE_REPEATS);
        if (collapse != null) Log.collapseRepeats = collapse;

        const rate = Number(env.WA_LOG_RATE_LIMIT);
        if (Number.isInteger(rate) && rate > 0) Log.rateLimit = rate;

        if (typeof env.WA_LOG_REDACT === "string" && env.WA_LOG_REDACT.trim().length > 0) {
            Log.setRedact(env.WA_LOG_REDACT.split(","));
        }

        // last, so the directory is already settled when the first log arrives
        if (typeof env.WA_LOG_DIR === "string" && env.WA_LOG_DIR.trim().length > 0) {
            Log.setDir(env.WA_LOG_DIR.trim());
        }
    }

    /** Writes whatever is still buffered when the process goes down. */
    protected static _initFlushOnExit() {
        const g: any = globalThis as any;
        if (g.__waLogExitHook) return;
        if (typeof process === "undefined" || !process || typeof process.on !== "function") return;
        g.__waLogExitHook = true;
        process.on("exit", () => {
            // writes the buffered lines and the queue, so nothing that already reached
            // the library is lost when the process exits in the same tick it logged
            Log.flush();
            Log.closeFile();
        });
    }

    protected static _initConsoleCapture() {

        // A duplicate copy of wa-log would otherwise wrap the already wrapped console.
        const g: any = globalThis as any;
        if (g.__waLogConsoleCaptured) return;
        g.__waLogConsoleCaptured = true;

        console.trace = (...msg: any[]) => {
            if (Log.consolePrint || Log.ignoreLog) Log._trace.apply(console, msg);
            Log.generic("CONSOLE", msg[0] ?? "trace", LogLevel.TRACE, msg.slice(1));
        };
        console.debug = (...msg: any[]) => {
            if (Log.consolePrint || Log.ignoreLog) Log._debug.apply(console, msg);
            Log.generic("CONSOLE", msg[0] ?? "debug", LogLevel.DEBUG, msg.slice(1));
        };

        console.log = (...msg: any[]) => {
            if (Log.consolePrint || Log.ignoreLog) Log._log.apply(console, msg);
            Log.generic("CONSOLE", msg[0] ?? "log", LogLevel.LOG, msg.slice(1));
        };

        console.info = (...msg: any[]) => {
            if (Log.consolePrint || Log.ignoreLog) Log._info.apply(console, msg);
            Log.generic("CONSOLE", msg[0] ?? "info", LogLevel.INFO, msg.slice(1));
        };
        console.warn = (...msg: any[]) => {
            if (Log.consolePrint || Log.ignoreLog) Log._warning.apply(console, msg);
            Log.generic("CONSOLE", msg[0] ?? "warn", LogLevel.WARN, msg.slice(1));
        };
        console.error = (...msg: any[]) => {
            if (Log.consolePrint || Log.ignoreLog) Log._error.apply(console, msg);
            Log.generic("CONSOLE", msg[0] ?? "error", LogLevel.ERROR, msg.slice(1));
        };
    }

    //#################################################################### Private

    private static generic(name: string, message: string, level: LogLevel, object: any) {
        if (!Log.ignoreLog) {
            const lines = Log.stackLines(Log.getErrorObject(), 4);

            const frame = Log.parseFrame(lines[0]);
            const local: string = frame.local;
            const cursor: string = frame.cursor;

            const d = new Date();
            let ld: LogData = {
                date: d,
                localDate: new Date(d.getTime() - d.getTimezoneOffset() * 60000),
                severity: level,
                name: name,
                message: message,
                object: object,
                local: local,
                cursor: cursor,
                stack: lines
            };
            Log.run(ld);
        }
    }

    private static generate(severity: LogLevel, name: string, message: string, object?: any) {
        const lines = Log.stackLines(Log.getErrorObject(), 4);

        const frame = Log.parseFrame(lines[0]);
        const local: string = frame.local;
        const cursor: string = frame.cursor;

        const d = new Date();
        let ld: LogData = {
            date: d,
            localDate: new Date(d.getTime() - d.getTimezoneOffset() * 60000),
            severity: severity,
            name: name,
            message: message,
            object: object ?? {},
            local: local,
            cursor: cursor,
            stack: lines
        };

        return (ld);
    }

    private static run(ld: LogData) {
        if (Log.ignoreLog) return;

        if (Log.redactKeys.length > 0) ld.object = Log.redact(ld.object, 0, new WeakSet<object>());
        if (!Log.admit(ld)) return;

        Log.deliver(ld);
    }

    /** Kept as fields so the very same reference can be handed to removeListener. */
    private static onUncaught = (error: any) => {
        Log.catch(error, LogLevel.FATAL);
        Log.crashExit("uncaughtException");
    };

    private static onRejection = (reason: any) => {
        Log.catch(reason, LogLevel.FATAL);
        Log.crashExit("unhandledRejection");
    };

    /**
     * Node would have ended the process on these events. Standing in the way to write
     * the log must not change that, unless the application is handling them as well.
     */
    private static crashExit(event: string) {
        Log.flush();
        try {
            if (process.listenerCount(event) > 1) return;
        } catch (e) {
            return;
        }
        Log.closeFile();
        process.exit(1);
    }

    /** The flood guards. false means the line was folded into a counter, not delivered. */
    private static admit(ld: LogData): boolean {
        if (Log.collapseRepeats) {
            const key = ld.severity + "|" + ld.name + "|" + ld.message;
            if (key === Log.repeatKey) {
                Log.repeatCount++;
                Log.repeatSample = ld;
                return false;
            }
            // the run ended, so its count goes out before the line that ended it
            Log.flushRepeats();
            Log.repeatKey = key;
        }

        if (Log.rateLimit > 0) {
            const second = Math.floor(Date.now() / 1000);
            if (second !== Log.rateSecond) {
                Log.rateSecond = second;
                Log.rateCount = 0;
                Log.flushDropped();
            }
            if (++Log.rateCount > Log.rateLimit) {
                Log.rateDropped++;
                return false;
            }
        }

        return true;
    }

    private static deliver(ld: LogData) {
        // pop, not slice: the history keeps its identity and allocates nothing
        if (Log.latestLogs.unshift(ld) > 100) {
            Log.latestLogs.pop();
        }
        if (ld.severity >= Log.levelSave) Log.salvar(ld);
        if (ld.severity >= Log.levelShow) Log.exibir(ld);
        Log.emit(ld.severity, ld);
    }

    /** Emits the count of a run of repeated messages, keeping the place they came from. */
    private static flushRepeats() {
        const sample = Log.repeatSample;
        const times = Log.repeatCount;
        Log.repeatCount = 0;
        Log.repeatSample = null;
        if (times <= 0 || sample === null) return;

        const d = new Date();
        Log.deliver({
            date: d,
            localDate: new Date(d.getTime() - d.getTimezoneOffset() * 60000),
            severity: sample.severity,
            name: sample.name,
            message: sample.message + " (repeated " + times + " times)",
            object: sample.object,
            local: sample.local,
            cursor: sample.cursor,
            stack: sample.stack
        });
    }

    /** Reports what the rate limit turned away, so a silence is never unexplained. */
    private static flushDropped() {
        const dropped = Log.rateDropped;
        Log.rateDropped = 0;
        if (dropped <= 0) return;

        const d = new Date();
        Log.deliver({
            date: d,
            localDate: new Date(d.getTime() - d.getTimezoneOffset() * 60000),
            severity: LogLevel.WARN,
            name: "WA-LOG",
            message: dropped + " logs dropped by the rate limit",
            object: {},
            local: "wa-log",
            cursor: "",
            stack: []
        });
    }

    /**
     * A copy of the payload with the configured keys masked. A copy, because the
     * caller keeps using the object it handed over, and because the console, the
     * listeners and the file all have to see the same masked version.
     */
    private static redact(value: any, depth: number, seen: WeakSet<object>): any {
        if (value === null || typeof value !== "object") return value;
        if (depth > 8) return value;
        if (seen.has(value)) return "[Circular]";
        if (value instanceof Date || value instanceof Error) return value;
        seen.add(value);

        if (Array.isArray(value)) {
            const list = new Array(value.length);
            for (let i = 0; i < value.length; i++) list[i] = Log.redact(value[i], depth + 1, seen);
            return list;
        }

        const copy: any = {};
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
            if (Log.redactKeys.indexOf(keys[i].toLowerCase()) >= 0) {
                copy[keys[i]] = "[redacted]";
                continue;
            }
            let inner: any;
            try { inner = value[keys[i]]; } catch (e) { inner = "[unreadable]"; }
            copy[keys[i]] = Log.redact(inner, depth + 1, seen);
        }
        return copy;
    }

    private static emit(severity: LogLevel | 'ANY', data: any) {
        const previous = Log.ignoreLog;
        Log.calls.forEach(call => {
            if (call.severity == severity || call.severity == 'any' || call.severity == 'ANY') {
                Log.ignoreLog = true;
                try {
                    call.callback(data);
                } catch (e) {
                } finally {
                    Log.ignoreLog = previous;
                }
            }
        });
    }

    /**
     * Registers a callback for one exact severity or for every record with `ANY`.
     * Logs created through `Log` inside the callback are ignored to prevent recursion;
     * `console.*` calls inside it pass directly to the native console.
     * @param severity Exact `LogLevel`, `ANY`, or `any`.
     * @param callback Function invoked with the generated `LogData` record.
     */
    public static onEvent(severity: LogLevel | 'ANY' | 'any', callback: (log: LogData) => void) {
        const idx = Log.calls.findIndex((call: any) => { return call.callback.toString() == callback.toString() && call.severity == severity });
        if (idx == -1) {
            Log.calls.push({ severity: severity, callback: callback });
        } else {
            Log.calls[idx] = { severity: severity, callback: callback };
        }
    }

    /**
     * Removes a callback registered through onEvent. Without this a listener, and
     * everything its closure holds on to, stays alive for the life of the process.
     * @param severity The same exact `LogLevel`, `ANY`, or `any` used to register.
     * @param callback Callback to remove. Omit it to remove every callback for that severity.
     * @returns Number of callbacks removed.
     */
    public static offEvent(severity: LogLevel | 'ANY' | 'any', callback?: (log: LogData) => void): number {
        const before = Log.calls.length;
        const source = (callback != null) ? callback.toString() : null;
        Log.calls = Log.calls.filter((call: any) => {
            return !(call.severity === severity && (source === null || call.callback.toString() === source));
        });
        return before - Log.calls.length;
    }

    /**
     * Applies the retention rules. Runs by itself when a rule is set, when the
     * directory changes and when the day rolls over, so nothing is left ticking in
     * the background. Safe to call by hand.
     * @returns Number of files deleted.
     */
    public static purge(): number {
        if (Log.purgeDays <= 0 && Log.purgeBytes <= 0) return 0;

        let removed = 0;
        try {
            if (!Log.dir || !fs.existsSync(Log.dir)) return 0;

            const today = Log.dayOf(new Date()).getTime();
            const names = fs.readdirSync(Log.dir);

            let total = 0;
            const older: Array<{ path: string, day: number, part: number, size: number }> = [];

            for (let i = 0; i < names.length; i++) {
                // only files this library writes; anything else in the directory is not ours
                const parsed = Log.parseLogName(names[i]);
                if (parsed === null) continue;

                const full = path.resolve(Log.dir, names[i]);
                let size = 0;
                try {
                    const stat = fs.statSync(full);
                    if (!stat.isFile()) continue;
                    size = stat.size;
                } catch (e) {
                    continue;
                }

                total += size;

                // the file being written stays, whatever the rules say. Earlier parts of
                // today are closed already, so the size rule may still reclaim them.
                if (full === Log.filePath || (parsed.day.getTime() === today && parsed.part === Log.filePart)) continue;

                older.push({ path: full, day: parsed.day.getTime(), part: parsed.part, size: size });
            }

            older.sort((a, b) => (a.day - b.day) || (a.part - b.part));

            // date arithmetic, not a multiplication: it has to survive daylight saving
            const now = new Date();
            const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Log.purgeDays - 1)).getTime();

            for (let i = 0; i < older.length; i++) {
                const tooOld = Log.purgeDays > 0 && older[i].day < cutoff;
                const tooBig = Log.purgeBytes > 0 && total > Log.purgeBytes;
                if (!tooOld && !tooBig) continue;

                try {
                    if (older[i].path === Log.fdFile) Log.closeFile();
                    fs.unlinkSync(older[i].path);
                    total -= older[i].size;
                    removed++;
                } catch (e) {

                }
            }
        } catch (e) {

        }
        return removed;
    }

    private static salvar(ld: LogData) {
        if (!Log.dirSettled) {
            Log.pending.push(ld);
            Log.scheduleFlush();
            // hard ceiling, so a process that never settles a directory still cannot grow the buffer
            if (Log.pending.length >= Log.PENDING_MAX) Log.flush();
            return;
        }
        Log.write(ld);
    }

    private static scheduleFlush() {
        if (Log.flushScheduled) return;
        Log.flushScheduled = true;
        try {
            // End of the current tick: module loading is over and the application
            // main already had its chance to call setDir.
            const timer: any = setImmediate(() => Log.flush());
            // unref so a pending flush never holds the process open; the exit hook covers it
            if (timer && typeof timer.unref === "function") timer.unref();
        } catch (e) {
            Log.flush();
        }
    }

    private static write(ld: LogData) {
        try {
            if (!Log.dir) return;

            // the moment the log happened, not the moment it is written, so a
            // buffered line never lands in the next day file
            const when = (ld.date instanceof Date) ? ld.date : new Date();

            const line = Log.serialize(ld) + "\r\n";
            Log.queue.push({ file: Log.dailyFile(when), line: line });
            Log.queueBytes += line.length;

            // hard ceiling: past it the caller waits for the disk instead of the queue growing
            if (Log.queueBytes >= Log.QUEUE_MAX_BYTES) {
                Log.drain();
                return;
            }
            Log.scheduleDrain();
        } catch (e) {

        }
    }

    /** The path of the file a given moment belongs to, resolved once per day. */
    private static dailyFile(when: Date): string {
        const day = Log.stampOf(when);
        if (day !== Log.fileDay || Log.dir !== Log.fileDir) {
            Log.fileDay = day;
            Log.fileDir = Log.dir;
            Log.filePart = Log.lastPartOf(day);
            Log.filePath = Log.partPath(day, Log.filePart);
            // first log of the process, a new directory, or midnight just passed
            Log.purge();
        }
        return Log.filePath;
    }

    /** The "YYYY-MM-DD" a moment belongs to, in local time. */
    private static stampOf(when: Date): string {
        return when.getFullYear() + "-" + ("00" + (when.getMonth() + 1)).slice(-2) + "-" + ("00" + when.getDate()).slice(-2);
    }

    private static partPath(day: string, part: number): string {
        return path.resolve(Log.dir, part > 0 ? day + "." + part + ".log" : day + ".log");
    }

    /** The highest part already written for a day, so a restart continues where it stopped. */
    private static lastPartOf(day: string): number {
        if (Log.rotateBytes <= 0) return 0;

        let last = 0;
        try {
            if (!Log.dir || !fs.existsSync(Log.dir)) return 0;
            const names = fs.readdirSync(Log.dir);
            for (let i = 0; i < names.length; i++) {
                const parsed = Log.parseLogName(names[i]);
                if (parsed !== null && parsed.stamp === day && parsed.part > last) last = parsed.part;
            }
        } catch (e) {

        }
        return last;
    }

    private static scheduleDrain() {
        if (Log.writeScheduled) return;
        Log.writeScheduled = true;
        try {
            const timer: any = setImmediate(() => Log.drain());
            // unref so a queued write never holds the process open; the exit hook covers it
            if (timer && typeof timer.unref === "function") timer.unref();
        } catch (e) {
            Log.drain();
        }
    }

    /** Writes the queue to disk, one append per destination file. */
    private static drain() {
        Log.writeScheduled = false;
        const queue = Log.queue;
        if (queue.length === 0) return;
        Log.queue = [];
        Log.queueBytes = 0;

        let target = queue[0].file;
        let chunk = "";
        for (let i = 0; i < queue.length; i++) {
            if (queue[i].file !== target) {
                Log.append(target, chunk);
                target = queue[i].file;
                chunk = "";
            }
            chunk += queue[i].line;
        }
        Log.append(target, chunk);
    }

    private static append(target: string, data: string) {
        try {
            // a batch is written in one call, so the rotation limit has to be applied
            // inside it: a burst would otherwise land whole in the file it overflows
            let remaining = data;

            while (remaining.length > 0) {
                const now = Date.now();

                if (Log.fdFile !== target) {
                    // a new day, a new directory or the next part
                    Log.closeFile();
                } else if (Log.fd != null && (now - Log.fdCheckedAt) >= Log.FD_CHECK_MS) {
                    // a cleanup script may have removed the file under us; the check is a
                    // stat, some 20x the cost of the write itself, so it is not done per write
                    Log.fdCheckedAt = now;
                    if (!fs.existsSync(target)) Log.closeFile();
                }

                if (Log.fd == null) {
                    const dir = path.dirname(target);
                    if (!fs.existsSync(dir)) {
                        // recursive: setDir may point several levels deep.
                        // mode: log payloads carry application data, keep them owner-only (no-op on Windows).
                        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                    }
                    Log.fd = fs.openSync(target, "a", 0o600);
                    Log.fdFile = target;
                    Log.fdCheckedAt = now;

                    // the file may already have content from an earlier run
                    let existing = 0;
                    try { existing = fs.fstatSync(Log.fd).size; } catch (e) { }
                    Log.fdBytes = existing;
                }

                const rotating = Log.rotateBytes > 0 && target === Log.filePath;

                // full: what is left of the batch belongs to the next part
                if (rotating && Log.fdBytes >= Log.rotateBytes) {
                    Log.filePart++;
                    Log.filePath = Log.partPath(Log.fileDay, Log.filePart);
                    target = Log.filePath;
                    continue;
                }

                let slice = remaining;
                if (rotating && Log.fdBytes + slice.length > Log.rotateBytes) {
                    slice = Log.cutToFit(remaining, Log.rotateBytes - Log.fdBytes);
                }
                if (slice.length === 0) break;

                fs.writeSync(Log.fd, slice);
                Log.fdBytes += slice.length;
                remaining = remaining.slice(slice.length);
            }
        } catch (e) {
            // the next write starts over with a fresh handle
            Log.closeFile();
        }
    }

    /**
     * As many whole lines as fit in the room left. A record is never split between two
     * files, so a single line larger than the limit still goes out in one piece.
     */
    private static cutToFit(data: string, room: number): string {
        const cut = room > 0 ? data.lastIndexOf("\r\n", room) : -1;
        if (cut >= 0) return data.slice(0, cut + 2);

        const first = data.indexOf("\r\n");
        return first < 0 ? data : data.slice(0, first + 2);
    }

    private static closeFile() {
        if (Log.fd != null) {
            try { fs.closeSync(Log.fd); } catch (e) { }
        }
        Log.fd = null;
        Log.fdFile = null;
        Log.fdBytes = 0;
    }

    private static exibir(ld: LogData) {
        try {
            const bg = [
                "\x1b[44m\x1b[30m",
                "\x1b[46m\x1b[30m",
                "\x1b[47m\x1b[30m",
                "\x1b[42m\x1b[30m",
                "\x1b[43m\x1b[30m",
                "\x1b[41m\x1b[30m",
                "\x1b[45m\x1b[30m"
            ];


            let printObj = Log.objectPrint;
            if (printObj) {
                if (ld.object instanceof Array) {
                    printObj = ld.object.length > 0;
                } else if (ld.object == undefined || ld.object == null) {
                    printObj = false;
                }
            }

            const name = Log.consoleName(ld.name);
            const location = Log.consoleLocation(ld);
            const args: Array<any> = [
                ld.localDate.toISOString().slice(0, 23).replace("T", " "),
                bg[ld.severity] + LogLevel[ld.severity].padEnd(5) + "\x1b[0m",
                name
            ];

            if (location.length > 0) args.push(location);
            args.push(Log.sanitize(ld?.message ?? "-"));
            Log._log.apply(console, args);

            if (printObj) Log._log.apply(console, [Log.consoleObject(ld.object)]);

        } catch (e) {
            Log._log.apply(console, [ld]);
        }
    }

    /** A bracketed name whose column starts compact, grows as needed and stays bounded. */
    private static consoleName(name: string): string {
        let inner = String(Log.sanitize(name) ?? "");
        const innerMax = Log.NAME_COLUMN_MAX - 2;
        if (inner.length > innerMax) inner = Log.truncateEnd(inner, innerMax);

        const value = "[" + inner + "]";
        Log.nameColumnWidth = Math.max(Log.nameColumnWidth, value.length);
        return value.padEnd(Log.nameColumnWidth);
    }

    /** Full-path and filename modes keep independent adaptive column widths. */
    private static consoleLocation(ld: LogData): string {
        if (!Log.pathPrint && !Log.filePrint) return "";

        const local = String(Log.sanitize(ld.local) ?? "");
        const cursor = String(Log.sanitize(ld.cursor) ?? "");

        if (Log.pathPrint) {
            const value = Log.truncateStart(local + ":" + cursor, Log.PATH_COLUMN_MAX);
            Log.pathColumnWidth = Math.max(Log.pathColumnWidth, value.length);
            return value.padEnd(Log.pathColumnWidth);
        }

        const file = local.split(/[/\\]/).pop() ?? "";
        const value = Log.truncateStart(file + ":" + cursor, Log.FILE_COLUMN_MAX);
        Log.fileColumnWidth = Math.max(Log.fileColumnWidth, value.length);
        return value.padEnd(Log.fileColumnWidth);
    }

    /** Objects get their own indented line; multiline inspection keeps the same margin. */
    private static consoleObject(object: any): string {
        const prefix = "    └─ ";
        const continuation = " ".repeat(prefix.length);
        const colors = typeof process !== "undefined" && !!process.stdout && process.stdout.isTTY === true;
        const rendered = typeof object === "string" ? object : inspect(object, { colors: colors });
        return prefix + rendered.replace(/\r?\n/g, "\n" + continuation);
    }

    private static truncateEnd(value: string, max: number): string {
        if (value.length <= max) return value;
        return max <= 1 ? "…".slice(0, max) : value.slice(0, max - 1) + "…";
    }

    private static truncateStart(value: string, max: number): string {
        if (value.length <= max) return value;
        return max <= 1 ? "…".slice(0, max) : "…" + value.slice(-(max - 1));
    }

    /**
     * Splits one stack frame into the source file and the "line:column" cursor.
     * Windows paths start with a drive letter, so the split has to happen on the
     * last colons of the frame, never on the first one.
     */
    private static parseFrame(frame: string): { local: string, cursor: string } {
        let local = (frame ?? "").trim();

        let sidx = local.indexOf("(") + 1;
        if (sidx <= 0) sidx = local.indexOf("at ") + 2;
        if (sidx <= 0) sidx = 0;
        let lidx = local.lastIndexOf(")");
        if (lidx <= 0) lidx = local.length;
        local = local.substring(sidx, lidx).trim();

        let cursor = local.substring(0, local.lastIndexOf(":")).trim();
        cursor = local.substring(cursor.lastIndexOf(":") + 1).trim();

        // no "line:column" in the frame, keep it whole instead of shredding it
        if (cursor === local) return { local: local, cursor: "" };

        local = local.substring(0, local.length - cursor.length - 1).trim();
        return { local: local, cursor: cursor };
    }

    private static getErrorObject(): any {
        // Constructing the Error captures the same frames a thrown one does, and
        // skips the throw/catch, which is roughly 8 us of the cost of every log.
        if (Log.stackDepth === null) return new Error("");

        // 4 of the collected frames are internal to the library, the rest is what
        // setStackDepth asked for. The limit is read when the Error is built, so it
        // can go back immediately, and reading it back costs nothing measurable.
        const keep = Error.stackTraceLimit;
        Error.stackTraceLimit = Log.stackDepth + 4;
        const error = new Error("");
        Error.stackTraceLimit = keep;
        return error;
    }

    private static captureNativeConsole(): any {
        const g: any = globalThis as any;
        if (!g.__waLogNativeConsole) {
            g.__waLogNativeConsole = {
                trace: console.trace, debug: console.debug, log: console.log,
                info: console.info, warn: console.warn, error: console.error
            };
        }
        return g.__waLogNativeConsole;
    }

    /**
     * The frames of a stack trace, already trimmed. Never empty, so callers can
     * read [0] without a crash when the runtime hands over a short or absent stack.
     */
    private static stackLines(error: any, skip: number): Array<string> {
        const raw: string = (error && typeof error.stack === "string") ? error.stack : "";
        const parts = raw.split("\n");

        const lines: Array<string> = [];
        for (let i = skip; i < parts.length; i++) {
            const frame = parts[i].trim();
            if (frame.length > 0) lines.push(frame);
        }
        return lines.length > 0 ? lines : ["unknown"];
    }

    /** Control characters are dropped so log content cannot repaint or forge terminal output. */
    private static sanitize(value: string): string {
        if (!Log.sanitizePrint || typeof value !== "string") return value;
        return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    }

    /** A log line is never dropped: what plain JSON cannot take, the guarded pass rescues. */
    private static serialize(ld: LogData): string {
        try {
            // a replacer function is called for every key, so the plain call goes first
            return JSON.stringify(ld);
        } catch (e) {
            return Log.serializeGuarded(ld);
        }
    }

    /** Survives circular references, BigInt, Error values and throwing getters. */
    private static serializeGuarded(ld: LogData): string {
        try {
            const seen = new WeakSet<object>();
            return JSON.stringify(ld, (key: string, value: any) => {
                if (typeof value === "bigint") return value.toString();
                if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
                if (typeof value === "object" && value !== null) {
                    if (seen.has(value)) return "[Circular]";
                    seen.add(value);
                }
                return value;
            });
        } catch (e) {
            // last resort: the payload is beyond rescue, the log line itself is not
            return JSON.stringify({
                date: ld.date, localDate: ld.localDate, severity: ld.severity,
                name: ld.name, message: ld.message, local: ld.local, cursor: ld.cursor,
                object: "[unserializable]", stack: ld.stack
            });
        }
    }

    /** A level given as a name ("INFO") or as a number ("3"). Anything else is ignored. */
    private static parseLevel(value: any): LogLevel {
        if (typeof value !== "string") return null;
        const raw = value.trim();
        if (raw.length === 0) return null;

        const byName = (LogLevel as any)[raw.toUpperCase()];
        if (typeof byName === "number") return byName;

        const byNumber = Number(raw);
        if (Number.isInteger(byNumber) && byNumber >= LogLevel.TRACE && byNumber <= LogLevel.FATAL) return byNumber;

        return null;
    }

    /** A byte count, plain or carrying a B/KB/MB/GB suffix. */
    private static parseSize(value: any): number {
        if (typeof value !== "string") return null;

        const parts = value.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/);
        if (parts === null) return null;

        let unit = 1;
        if (parts[2] === "KB") unit = 1024;
        else if (parts[2] === "MB") unit = 1024 * 1024;
        else if (parts[2] === "GB") unit = 1024 * 1024 * 1024;

        const bytes = Math.floor(Number(parts[1]) * unit);
        return bytes > 0 ? bytes : null;
    }

    private static parseBool(value: any): boolean {
        if (typeof value !== "string") return null;
        const raw = value.trim().toLowerCase();
        if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
        if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
        return null;
    }

    /** Midnight of the given date, in local time, matching how log files are named. */
    private static dayOf(date: Date): Date {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    /**
     * Reads a "YYYY-MM-DD.log" or "YYYY-MM-DD.3.log" file name. Returns null for
     * anything else, which is what keeps the purge away from files that are not ours.
     */
    private static parseLogName(name: string): { day: Date, part: number, stamp: string } {
        const parts = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.log$/.exec(name);
        if (parts === null) return null;

        const y = Number(parts[1]), m = Number(parts[2]), d = Number(parts[3]);
        const day = new Date(y, m - 1, d);
        if (isNaN(day.getTime())) return null;

        // "2026-13-45" parses into another month, so the name has to survive a round trip
        const stamp = Log.stampOf(day);
        if (stamp !== parts[1] + "-" + parts[2] + "-" + parts[3]) return null;

        return { day: day, part: parts[4] === undefined ? 0 : Number(parts[4]), stamp: stamp };
    }

    /** Local midnight a log file stands for, or null when the name is not one of ours. */
    private static dayOfFile(name: string): Date {
        const parsed = Log.parseLogName(name);
        return parsed === null ? null : parsed.day;
    }

    private static describe(value: any): string {
        if (typeof value === "string") return value;
        try { return JSON.stringify(value) ?? String(value); } catch (e) { return String(value); }
    }


}
// only internal use to init Log.
class LogInit extends Log {
    public static init() {
        super._initEnv();
        super._initFlushOnExit();
        super._initConsoleCapture();
    }
}

LogInit.init();


export { Log, LogData, LogLevel };
