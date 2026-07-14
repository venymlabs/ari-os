export type UserRequest = {
  group: "setup" | "wallet" | "portfolio" | "trade" | "signer";
  action: string;
  args: Record<string, string | boolean>;
};
export type CliCommand =
  | { name: "chat"; message: string; sessionId?: string }
  | { name: "simulate"; input: unknown }
  | { name: "status" | "sessions" | "tools" | "skills" | "markets" | "jobs" }
  | ({ name: "user" } & UserRequest);
export interface CliServices {
  chat(x: { message: string; sessionId?: string }): unknown;
  status(): unknown;
  sessions(): unknown;
  tools(): unknown;
  skills(): unknown;
  markets(): unknown;
  simulate(x: unknown): unknown;
  jobs(): unknown;
  user(x: UserRequest): unknown;
}
const simple = new Set([
  "status",
  "sessions",
  "tools",
  "skills",
  "markets",
  "jobs",
]);
function userCommand(name: string, args: string[]): CliCommand | undefined {
  if (
    !["setup", "init", "wallet", "portfolio", "trade", "signer"].includes(name)
  )
    return;
  const group = name === "init" ? "setup" : (name as UserRequest["group"]);
  const action =
    group === "setup" ? "init" : group === "portfolio" ? "show" : args.shift();
  if (!action) throw Error(`${group} action required`);
  const valid: Record<string, string[]> = {
    wallet: ["create", "import", "address", "status"],
    trade: [
      "quote",
      "buy",
      "sell",
      "approve",
      "deny",
      "submit",
      "status",
      "reconcile",
    ],
    signer: ["start", "status", "reconcile"],
  };
  if (valid[group] && !valid[group]!.includes(action))
    throw Error(`Unknown ${group} action: ${action}`);
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!;
    if (!x.startsWith("--")) throw Error(`Unexpected argument: ${x}`);
    const key = x.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (args[i + 1] && !args[i + 1]!.startsWith("--")) out[key] = args[++i]!;
    else out[key] = true;
  }
  return { name: "user", group, action, args: out };
}
export function parseCommand(argv: string[]): CliCommand {
  const [name, ...args] = argv;
  if (!name) throw new Error("Command required");
  const u = userCommand(name, args);
  if (u) return u;
  if (simple.has(name)) {
    if (args.length) throw new Error(`Unexpected arguments for ${name}`);
    return { name: name as "status" };
  }
  if (name === "simulate") {
    if (args.length !== 1)
      throw new Error("simulate requires one JSON argument");
    try {
      return { name, input: JSON.parse(args[0]!) };
    } catch {
      throw new Error("Invalid simulation JSON");
    }
  }
  if (name === "chat") {
    let sessionId: string | undefined;
    const at = args.indexOf("--session");
    if (at >= 0) {
      sessionId = args[at + 1];
      if (!sessionId || at !== args.length - 2)
        throw new Error("Invalid --session option");
      args.splice(at, 2);
    }
    const message = args.join(" ").trim();
    if (!message) throw new Error("chat message required");
    return { name, message, ...(sessionId === undefined ? {} : { sessionId }) };
  }
  throw new Error(`Unknown command: ${name}`);
}
const safeError = (e: unknown) => ({
  error:
    e instanceof Error
      ? e.message.replace(
          /(?:token|secret|key|password)\s*[=:]\s*\S+/gi,
          "[redacted]",
        )
      : "Command failed",
});
export async function runCli(
  argv: string[],
  services: CliServices,
  write: (text: string) => void = (x) => process.stdout.write(x + "\n"),
) {
  try {
    const c = parseCommand(argv);
    let result: unknown;
    if (c.name === "chat")
      result = await services.chat({
        message: c.message,
        ...(c.sessionId === undefined ? {} : { sessionId: c.sessionId }),
      });
    else if (c.name === "simulate") result = await services.simulate(c.input);
    else if (c.name === "user")
      result = await services.user({
        group: c.group,
        action: c.action,
        args: c.args,
      });
    else result = await services[c.name]();
    write(
      JSON.stringify({ ok: true, result }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
    return 0;
  } catch (e) {
    write(JSON.stringify({ ok: false, ...safeError(e) }));
    return 1;
  }
}
