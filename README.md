Simple use console.log as usual

OR

## Import the Lib
```
import Log, { LogData, LogLevel } from ".";
```

## Get events
```
Log.onEvent("ANY", (log: LogData) => {
    console.log("log ANY:", log.message);
});
Log.onEvent(LogLevel.ERROR, (log: LogData) => {
    console.log("log ERROR:", log.message);
});
```

## Generates a log
```
Log.info("TESTE", "Testando info", { teste: "1" });
```
