import { Log } from ".";

Log.setLevel(0, 0);

Log.trace("APP", "TRACE");
Log.debug("APP", "DEBUG");
Log.log("APP", "LOG  ");
Log.info("APP", "INFO ");
Log.warn("APP", "WARN ");
Log.error("APP", "ERROR");
Log.fatal("APP", "FATAL");

Log.trace("APP-LONG-NAME", "TRACE");
Log.debug("APP-LONG-NAME", "DEBUG");
Log.log("APP-LONG-NAME", "LOG  ");
Log.info("APP-LONG-NAME", "INFO ");
Log.warn("APP-LONG-NAME", "WARN ");
Log.error("APP-LONG-NAME", "ERROR");
Log.fatal("APP-LONG-NAME", "FATAL");

Log.setLevel(3, 0);
Log.setPathPrint(false);
Log.setObjectPrint(true);

Log.trace("APP", "TRACE", { test: "TEST", test2: ["TEST2", "TEST3"] });
Log.debug("APP", "DEBUG", { test: "TEST", test2: ["TEST2", "TEST3"] });
Log.log("APP", "LOG  ", { test: "TEST", test2: ["TEST2", "TEST3"] });
Log.info("APP", "INFO ", { test: "TEST", test2: ["TEST2", "TEST3"] });
Log.warn("APP", "WARN ", { test: "TEST", test2: ["TEST2", "TEST3"] });
Log.error("APP", "ERROR", { test: "TEST", test2: ["TEST2", "TEST3"] });
Log.fatal("APP", "FATAL", { test: "TEST", test2: ["TEST2", "TEST3"] });

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
