import { Log } from ".";

Log.setLevel(0, 0);

Log.trace("APP", "TRACE");
Log.debug("APP", "DEBUG");
Log.log("APP", "LOG  ");
Log.info("APP", "INFO ");
Log.warn("APP", "WARN ");
Log.error("APP", "ERROR");
Log.fatal("APP", "FATAL");

Log.setLevel(3, 0);
Log.setPathPrint(false);

Log.trace("APP", "TRACE");
Log.debug("APP", "DEBUG");
Log.log("APP", "LOG  ");
Log.info("APP", "INFO ");
Log.warn("APP", "WARN ");
Log.error("APP", "ERROR");
Log.fatal("APP", "FATAL");


Log.setLevel(3, 3);
Log.setPathPrint(false);
Log.setFilePrint(false);

Log.trace("APP", "TRACE");
Log.debug("APP", "DEBUG");
Log.log("APP", "LOG  ");
Log.info("APP", "INFO ");
Log.warn("APP", "WARN ");
Log.error("APP", "ERROR");
Log.fatal("APP", "FATAL");