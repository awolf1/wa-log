import Log, { LogData, LogLevel } from ".";


Log.onEvent("ANY", (log: LogData) => {
    console.log("log ANY:", log.message);
});
Log.onEvent(LogLevel.ERROR, (log: LogData) => {
    console.log("log ERROR:", log.message);
});

Log.setConsolePrint(false);

console.log("Log do console");

console.error("Erro do console");

Log.info("TESTE", "Testando info", { teste: "1" });

teste();

function teste() {
    Log.warn("TESTE", "Testando warn", { teste: "2" });
}


Log.getLogs(new Date("2022-06-26 09:22:50"), new Date("2022-06-27 09:22:50"));
