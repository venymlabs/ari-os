import { loadConfig, sanitizedConfig } from "../config/index.js";
import {
  checkDatabases,
  databaseStatus,
  migrateDatabases,
} from "../storage/maintenance.js";

export async function main(command = process.argv[2] ?? "config") {
  const c = loadConfig(process.env);
  const paths = Object.values(c.paths).filter((p) => p.endsWith(".sqlite"));
  if (command === "config") {
    console.log(JSON.stringify(sanitizedConfig(c), null, 2));
    return;
  }
  const operation =
    command === "db:migrate"
      ? migrateDatabases
      : command === "db:status"
        ? databaseStatus
        : command === "db:integrity"
          ? checkDatabases
          : undefined;
  if (!operation) throw new Error(`Unknown maintenance command: ${command}`);
  const databases = operation(paths);
  console.log(
    JSON.stringify(
      { command, ok: databases.every((x) => x.integrity === "ok"), databases },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
