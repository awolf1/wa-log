import path from "path";
import fs from 'fs';


/**
 ### WA - Log Package
 ## LogLevel @enum {number} 
  
 **  TRACE  -> Dev     -> Variable status
 **  DEBUG  -> Dev     -> Information for bug catch


 **  LOG    -> GENERIC -> Commonly used


 **  INFO   -> User    -> Information
 **  WARN   -> User    -> Catch normal opearation
 **  ERROR  -> User    -> Catch fault operation
 **  FATAL  -> User    -> Catch fault system
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


/**
 ### WA - Log Package
 ## LogLevel @interface
 
 **  date: Date
 **  severity: LogLevel
 **  message: string
 **  object: any
 **  name: string
 **  local: string
 **  cursor: string
 **  stack: Array<string>
 */
interface LogData {
    date: Date;
    localDate: Date;
    severity: LogLevel;
    message: string;
    object: any;
    name: string;
    local: string;
    cursor: string;
    stack: Array<string>;
}


//const LogEmitter = new EventEmitter();

/**
 ### WA - Log Package
 ## Log @class

 Used to print logs e register console.<error | info | log | warn> output.

 All object are static to simplify the use.
        
 @example
    Log.trace("APP", "trace log");
    Log.debug("APP", "debug log");
    Log.info("APP", "info log");
    Log.warn("APP", "warn log");
    Log.error("APP", "error log");
    Log.fatal("APP", "fatal log");
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

    private static _trace = console.trace;
    private static _debug = console.debug;
    private static _log = console.log;
    private static _info = console.info;
    private static _warning = console.warn;
    private static _error = console.error;

    private static calls = new Array();

    //#################################################################### Public - setter

    /**
     * Set if the log will print the path and cursor or not.
     * @param print - Can print the path
     */
    public static setPathPrint(print: boolean) {
        Log.pathPrint = print;
    }

    /**
     * Set if the log will print the filename and cursor or not.
     * @param print - Can print just filename
     */
    public static setFilePrint(print: boolean) {
        Log.filePrint = print;
    }

    /**
     * Set if the console.<error | info | log | warn> can print on console or not.
     * @param print - Can print the console call
     */
    public static setConsolePrint(print: boolean) {
        Log.consolePrint = print;
    }

    /**
     * Set if the log will print the object parameter or not.
     * @param print - Can print to console the object.
     */
    public static setObjectPrint(print: boolean) {
        Log.objectPrint = print;
    }

    /**
     * Set minimum log levels to:
     * @param show - Show on cosole -> Default: (3) INFO
     * @param save  - Save to file -> Default: (0) TRACE
     */
    public static setLevel(show: LogLevel, save: LogLevel) {
        Log.levelShow = show;
        Log.levelSave = save;
    }

    /**
     *  Change the default directory to save log files.
     * @param dir - Path to directory
     * @return {boolean} - If the directory has been changed
     */
    public static setDir(dir: string): boolean {
        try {
            dir = path.resolve(dir);
            if (fs.lstatSync(dir).isDirectory()) {
                Log.dir = dir;
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


    //#################################################################### Public - getter

    /**
     * @return {LogData} - The last log generated
     */
    public static getLastLog(): LogData {
        return Log.latestLogs[0];
    }
    /**
     * @return {Array<LogData>} - The 100 last logs generated
     */
    public static getLatestLogs(): Array<LogData> {
        return Log.latestLogs;
    }
    /**
     * Get all logs between dates
     * @param start - The initial Date
     * @param end - The final Date
     * @return {Array<LogData>} - The log data
     */
    public static getLogs(start: Date, end: Date): Array<LogData> {
        let ret: Array<LogData> = [];
        if (fs.existsSync(Log.dir)) {
            let files = fs.readdirSync(Log.dir);

            let s = new Date(start.toISOString().slice(0, 10));
            let e = new Date(end.toISOString().slice(0, 10));

            for (let i = 0; i < files.length; i++) {
                let f: Date = new Date(files[i].substr(0, files[i].indexOf(".log")));
                if (f >= s && f <= e) {
                    let lines = fs.readFileSync(path.resolve(Log.dir, files[i])).toString().split("\n");
                    for (let j = 0; j < lines.length; j++) {
                        try {
                            let line = JSON.parse(lines[j]);
                            let ld = new Date(line.date);
                            if (ld >= start && ld <= end) {
                                ret.push(line);
                            }
                        } catch (e) {

                        }
                    }
                }
            }
        }
        return ret;
    }

    //#################################################################### Public - logs

    /**
     * Catch an error Object
     * @param error - The error stack
     * @param severity - The optional log severity -> Default: (3) INFO
     * @param object - The optional object to include into log message
     * @example
     * let someObj = {t:'a'}
     * try{
     *  //something that throws exception
     * }catch(e){
     *  Log.catch(e, LogLevel.INFO, someObj);
     * }
     */
    public static catch(error: Error, severity?: LogLevel, object?: any) {
        if (severity == null) {
            severity = LogLevel.INFO;
        }
        let er = Log.getErrorObject();

        let stack: Array<string> = error.stack?.split("\n") ?? er.stack.split("\n").slice(4);

        for (let i = 0; i < stack.length; i++) {
            if (stack[i].includes(":") && stack[i].includes("/")) {
                stack = stack.slice(i);
                break;
            }
        }

        let local: string = stack[0];

        let idx = local.lastIndexOf(")");
        if (idx <= 0) idx = local.length;
        let cursor = local.substring(local.indexOf(":") + 1, idx).trim();

        idx = local.indexOf("(") + 1;
        if (idx <= 0) idx = local.indexOf("\\") - 1;
        if (idx <= 0) idx = local.indexOf("at ") + 2;
        local = local.substring(idx, local.indexOf(":")).trim();

        const d = new Date();
        let ld: LogData = {
            date: d,
            localDate: new Date(d.getTime() - d.getTimezoneOffset() * 60000),
            severity: severity,
            name: error.name,
            message: error.message,
            object: object,
            local: local,
            cursor: cursor,
            stack: stack.map((s: string) => s.trim())
        };
        Log.run(ld);
    }

    /**
     * Generate a `TRACE` log level: 0
     * @param name - The class name of the log
     * @param message - The log message of the log
     * @param object - The optional object to include into log message
     */
    public static trace(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.TRACE, name, message, object));
    }

    /**
     * Generate a `DEBUG` log level: 1
     * @param name - The class name of the log
     * @param message - The log message of the log
     * @param object - The optional object to include into log message
     */
    public static debug(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.DEBUG, name, message, object));
    }

    /**
     * Generate a `LOG` log level: 2
     * @param name - The class name of the log
     * @param message - The log message of the log
     * @param object - The optional object to include into log message
     */
    public static log(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.LOG, name, message, object));
    }

    /**
     * Generate a `INFO` log level: 3
     * @param name - The class name of the log
     * @param message - The log message of the log
     * @param object - The optional object to include into log message
     */
    public static info(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.INFO, name, message, object));
    }

    /**
     * Generate a `WARNING` log level: 4
     * @param name - The class name of the log
     * @param message - The log message of the log
     * @param object - The optional object to include into log message
     */
    public static warn(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.WARN, name, message, object));
    }

    /**
     * Generate a `ERROR` log level: 5
     * @param name - The class name of the log
     * @param message - The log message of the log
     * @param object - The optional object to include into log message
     */
    public static error(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.ERROR, name, message, object));
    }

    /**
     * Generate a `FALTA` log level: 6
     * @param name - The class name of the log
     * @param message - The log message of the log
     * @param object - The optional object to include into log message
     */
    public static fatal(name: string, message: string, object?: any) {
        Log.run(Log.generate(LogLevel.FATAL, name, message, object));
    }


    //#################################################################### Protected - init

    protected static _initConsoleCapture() {

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
            let error = Log.getErrorObject();

            let local: string = error.stack.split("\n")[4].trim();

            let idx = local.lastIndexOf(")");
            if (idx <= 0) idx = local.length;
            let cursor = local.substring(local.indexOf(":") + 1, idx).trim();

            idx = local.indexOf("(") + 1;
            if (idx <= 0) idx = local.indexOf("\\") - 1;
            if (idx <= 0) idx = local.indexOf("at ") + 2;
            local = local.substring(idx, local.indexOf(":")).trim();

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
                stack: error.stack.split("\n").slice(4).map((s: string) => s.trim())
            };
            Log.run(ld);
        }
    }

    private static generate(severity: LogLevel, name: string, message: string, object?: any) {
        let error = Log.getErrorObject();

        let local: string = error.stack.split("\n")[4].trim();

        let sidx = local.indexOf("(") + 1;
        if (sidx <= 0) sidx = local.indexOf("at ") + 2;
        if (sidx <= 0) sidx = 0;
        let lidx = local.lastIndexOf(")");
        if (lidx <= 0) lidx = local.length;

        local = local.substring(sidx, lidx).trim();

        let cursor = local.substring(0, local.lastIndexOf(":")).trim();
        cursor = local.substring(cursor.lastIndexOf(":") + 1).trim();


        local = local.substring(0, local.length - cursor.length - 1).trim();

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
            stack: error.stack.split("\n").slice(4).map((s: string) => s.trim())
        };

        return (ld);
    }

    private static run(ld: LogData) {
        if (!Log.ignoreLog) {
            if (Log.latestLogs.unshift(ld) > 100) {
                Log.latestLogs = Log.latestLogs.slice(0, 100);
            }
            if (ld.severity >= Log.levelSave) Log.salvar(ld);
            if (ld.severity >= Log.levelShow) Log.exibir(ld);
            Log.emit(ld.severity, ld);
        }
    }

    private static emit(severity: LogLevel | 'ANY', data: any) {
        Log.calls.forEach(call => {
            if (call.severity == severity || call.severity == 'any' || call.severity == 'ANY') {
                Log.ignoreLog = true;
                try {
                    call.callback(data);
                } catch (e) {
                }
                Log.ignoreLog = false;
            }
        });
    }

    /**
     * Callback a function when a new log is generated.
     * The `Log` calls inside the callback function is not stored or printed.
     * All the console functions calls run direct to console, bypassing de Log class.
     * @param severity - LogLevel or ANY
     * @param callback - Callback function `(log: LogData)=>{}`
     */
    public static onEvent(severity: LogLevel | 'ANY' | 'any', callback: (log: LogData) => void) {
        const idx = Log.calls.findIndex((call: any) => { return call.callback.toString() == callback.toString() && call.severity == severity });
        if (idx == -1) {
            Log.calls.push({ severity: severity, callback: callback });
        } else {
            Log.calls[idx] = { severity: severity, callback: callback };
        }
    }

    private static salvar(ld: LogData) {
        try {
            if (Log.dir) {
                if (!fs.existsSync(Log.dir)) {
                    fs.mkdirSync(Log.dir);
                }
                let now = new Date();
                let p = path.resolve(Log.dir, now.getFullYear() + "-" + ("00" + (now.getMonth() + 1)).slice(-2) + "-" + ("00" + now.getDate()).slice(-2) + ".log");
                fs.appendFile(p, JSON.stringify(ld) + "\r\n", (err: any) => { });
            }
        } catch (e) {

        }
    }

    private static exibir(ld: LogData) {
        try {
            let bg = [
                "\x1b[44m\x1b[30m",
                "\x1b[46m\x1b[30m",
                "",//"\x1b[47m\x1b[30m",
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

            Log._log.apply(console,
                [ld.localDate.toISOString().slice(0, 23).replace("T", " ") + " ",
                bg[ld.severity] + ("_" + LogLevel[ld.severity] + "_" + "\x1b[0m").padEnd(13),
                ("[" + ld.name + "]").padEnd(15),
                (Log.pathPrint ? (ld.local + ":" + ld.cursor).padEnd(65) : (Log.filePrint ? (ld.local.split(/[/\\]/).pop() + ":" + ld.cursor).padEnd(20) : "")),
                (ld?.message ?? "-").padEnd(30),
                (printObj ? ld.object : "")
                ]);

        } catch (e) {
            Log._log.apply(console, [ld]);
        }
    }

    private static getErrorObject(): any {
        try { throw Error("") } catch (err) { return err; }
    }


}
// only internal use to init Log.
class LogInit extends Log {
    public static init() {
        super._initConsoleCapture();
    }
}

LogInit.init();


export { Log, LogData, LogLevel };
