import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseDocument } from "yaml";

export type SkillSource = "workspace" | "local" | "bundled";
export interface SkillReadiness {
  ready: boolean;
  missingEnv: string[];
  missingBinaries: string[];
  missingConfig: string[];
}
export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly checksum: string;
  readonly source: SkillSource;
  readonly capabilities: string[];
  readonly readiness: SkillReadiness;
}
export interface LoadedSkill extends SkillMetadata {
  readonly content: string;
  readonly suspicious: string[];
}
type Roots = Partial<Record<SkillSource, string>>;
type Parsed = {
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  requires: { env: string[]; binaries: string[]; config: string[] };
  content: string;
};
type Item = {
  source: SkillSource;
  dir: string;
  text: string;
  parsed: Parsed;
  support: Map<string, string>;
  digest: string;
};
const SOURCES: SkillSource[] = ["workspace", "local", "bundled"];
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const CONFIG =
  /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z][A-Za-z0-9_-]{0,63}){0,15}$/;
const DANGEROUS = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_CAPS = new Set([
  "research",
  "analysis",
  "writing",
  "coding",
  "data",
  "monitoring",
]);
const SUPPORT = new Set(["references", "templates", "scripts", "assets"]);
const MAX_MANIFEST = 256 * 1024,
  MAX_FILE = 1024 * 1024,
  MAX_FILES = 256,
  MAX_LIST = 64;
function parse(text: string): Parsed {
  if (Buffer.byteLength(text) > MAX_MANIFEST)
    throw new Error("Skill manifest exceeds size limit");
  if (!text.startsWith("---\n"))
    throw new Error("Skill must have YAML frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Unterminated frontmatter");
  const document = parseDocument(text.slice(4, end), {
    schema: "core",
    uniqueKeys: true,
    customTags: [],
  });
  if (document.errors.length)
    throw new Error(`Invalid frontmatter: ${document.errors[0]!.message}`);
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid frontmatter schema");
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    "name",
    "description",
    "version",
    "capabilities",
    "requires",
  ]);
  for (const key of Object.keys(obj))
    if (!allowed.has(key)) throw new Error(`Unknown frontmatter field: ${key}`);
  const str = (k: string, max: number) => {
    const v = obj[k];
    if (typeof v !== "string" || !v || v.length > max)
      throw new Error(`Invalid ${k}`);
    return v;
  };
  const arr = (v: unknown, label: string, re: RegExp) => {
    if (v === undefined) return [];
    if (
      !Array.isArray(v) ||
      v.length > MAX_LIST ||
      v.some((x) => typeof x !== "string" || !re.test(x))
    )
      throw new Error(`Invalid ${label} requirement`);
    return [...new Set(v as string[])];
  };
  const capabilities = arr(obj.capabilities, "capability", /^[a-z]{1,32}$/);
  for (const cap of capabilities)
    if (!ALLOWED_CAPS.has(cap)) throw new Error(`Forbidden capability: ${cap}`);
  const req = obj.requires ?? {};
  if (!req || typeof req !== "object" || Array.isArray(req))
    throw new Error("Invalid requires schema");
  for (const key of Object.keys(req as object))
    if (!["env", "binaries", "config"].includes(key))
      throw new Error(`Unknown requires field: ${key}`);
  const r = req as Record<string, unknown>;
  const config = arr(r.config, "config", CONFIG);
  if (config.some((x) => x.split(".").some((y) => DANGEROUS.has(y))))
    throw new Error("Invalid config requirement");
  const name = str("name", 64);
  if (!NAME.test(name)) throw new Error("Invalid skill name");
  const version = str("version", 128);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error("Invalid version");
  return {
    name,
    description: str("description", 4096),
    version,
    capabilities,
    requires: {
      env: arr(r.env, "environment", ENV),
      binaries: arr(r.binaries, "binary", BIN),
      config,
    },
    content: text.slice(end + 5),
  };
}
const frozen = <T>(v: T): T => {
  if (v && typeof v === "object") {
    for (const x of Object.values(v as object)) frozen(x);
    Object.freeze(v);
  }
  return v;
};
function configured(config: unknown, path: string) {
  let v: unknown = config;
  for (const key of path.split(".")) {
    if (
      DANGEROUS.has(key) ||
      !v ||
      typeof v !== "object" ||
      !Object.prototype.hasOwnProperty.call(v, key)
    )
      return false;
    v = (v as Record<string, unknown>)[key];
  }
  return v !== undefined && v !== false && v !== null;
}
async function binaryExists(name: string, pathValue: string | undefined) {
  if (!BIN.test(name) || pathValue === undefined) return false;
  // Windows resolves executables through PATHEXT-style suffixes.
  const candidates =
    process.platform === "win32"
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.com`]
      : [name];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        const s = await stat(full);
        if (s.isFile()) {
          await access(full, constants.X_OK);
          return true;
        }
      } catch {}
    }
  }
  return false;
}
function safeRelative(path: string) {
  if (!path || isAbsolute(path) || path.includes("\0"))
    throw new Error("Invalid path");
  const parts = path.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === "." || !p))
    throw new Error("Path traversal rejected");
  return parts.join(sep);
}
function contained(base: string, target: string) {
  const r = relative(base, target);
  return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
}
async function readNoFollow(path: string, base: string, max = MAX_FILE) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fh = await open(path, constants.O_RDONLY | noFollow);
  try {
    const s = await fh.stat();
    if (!s.isFile()) throw new Error("Path is not a regular file");
    if (s.size > max) throw new Error("File exceeds size limit");
    // Linux can resolve the opened descriptor itself, which is immune to
    // path swaps after open; elsewhere fall back to resolving the path.
    const canonical =
      process.platform === "linux"
        ? await realpath(`/proc/self/fd/${fh.fd}`)
        : await realpath(path);
    if (!contained(base, canonical)) throw new Error("Symlink escape rejected");
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}
// Support-file map keys participate in skill checksums; keep them in
// POSIX form so digests are identical across platform path separators.
const posixKey = (path: string) => path.split(/[\\/]/).join("/");
const posixKeyed = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([k, v]) => [posixKey(k), v] as const));
async function supportFiles(dir: string, base: string) {
  const out = new Map<string, string>();
  for (const top of SUPPORT) {
    const root = join(dir, top);
    let entries;
    try {
      if ((await lstat(root)).isSymbolicLink())
        throw new Error("Symlink supporting directory rejected");
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (!ent.isFile()) continue;
      if (out.size >= MAX_FILES)
        throw new Error("Supporting file count limit exceeded");
      const full = join(ent.parentPath, ent.name),
        rel = relative(dir, full);
      out.set(posixKey(rel), await readNoFollow(full, base));
    }
  }
  return out;
}
function digest(text: string, files: Map<string, string>) {
  const h = createHash("sha256").update("SKILL.md\0").update(text);
  for (const [p, v] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    h.update("\0").update(p).update("\0").update(v);
  return h.digest("hex");
}
const suspicious = (text: string) =>
  [
    /ignore\W+(?:all\W+)?previous\W+instructions/gi,
    /reveal\W+(?:the\W+)?system\W+prompt/gi,
    /bypass\W+(?:security|policy)/gi,
    /exfiltrat\w*/gi,
  ].flatMap((r) => text.match(r) ?? []);

export class SkillManager {
  private readonly roots: Roots;
  private readonly env: Record<string, string | undefined>;
  private readonly config: unknown;
  private readonly controlledRoot: string | undefined;
  constructor(options: {
    roots: Roots;
    env?: Record<string, string | undefined>;
    config?: unknown;
    controlledRoot?: string;
  }) {
    this.roots = options.roots;
    this.env = options.env ?? process.env;
    this.config = options.config ?? {};
    this.controlledRoot = options.controlledRoot;
  }
  private async selected() {
    const result = new Map<string, Item>();
    for (const source of SOURCES) {
      const root = this.roots[source];
      if (!root) continue;
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      for (const entry of entries) {
        if (
          result.has(entry.name) ||
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !NAME.test(entry.name)
        )
          continue;
        const dir = join(root, entry.name);
        if ((await lstat(dir)).isSymbolicLink()) continue;
        const base = await realpath(dir);
        const manifest = join(dir, "SKILL.md");
        try {
          if ((await lstat(manifest)).isSymbolicLink())
            throw new Error("Symlink manifest rejected");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        const text = await readNoFollow(manifest, base, MAX_MANIFEST),
          parsed = parse(text);
        if (parsed.name !== entry.name)
          throw new Error(`Skill directory/name mismatch: ${entry.name}`);
        const support = await supportFiles(dir, base);
        result.set(parsed.name, {
          source,
          dir,
          text,
          parsed,
          support,
          digest: digest(text, support),
        });
      }
    }
    return result;
  }
  private async metadata(item: Item) {
    const p = item.parsed,
      missingEnv = p.requires.env.filter((n) => !this.env[n]),
      missingConfig = p.requires.config.filter(
        (n) => !configured(this.config, n),
      ),
      missingBinaries: string[] = [];
    for (const n of p.requires.binaries)
      if (!(await binaryExists(n, this.env.PATH))) missingBinaries.push(n);
    return frozen({
      name: p.name,
      description: p.description,
      version: p.version,
      checksum: item.digest,
      source: item.source,
      capabilities: [...p.capabilities],
      readiness: {
        ready: !(
          missingEnv.length +
          missingConfig.length +
          missingBinaries.length
        ),
        missingEnv,
        missingBinaries,
        missingConfig,
      },
    } satisfies SkillMetadata);
  }
  async discover() {
    const s = await this.selected();
    return Promise.all(
      [...s.values()]
        .sort((a, b) => a.parsed.name.localeCompare(b.parsed.name))
        .map((x) => this.metadata(x)),
    );
  }
  async load(
    name: string,
    pin: { version?: string; checksum?: string } = {},
  ): Promise<LoadedSkill> {
    if (!NAME.test(name)) throw new Error("Invalid skill name");
    const item = (await this.selected()).get(name);
    if (!item) throw new Error(`Unknown skill: ${name}`);
    const meta = await this.metadata(item);
    if (pin.version && pin.version !== meta.version)
      throw new Error("Skill version pin mismatch");
    if (pin.checksum && pin.checksum !== meta.checksum)
      throw new Error("Skill checksum pin mismatch");
    return frozen({
      ...meta,
      content: item.parsed.content,
      suspicious: suspicious(
        item.text + "\n" + [...item.support.values()].join("\n"),
      ),
    });
  }
  async loadFile(name: string, path: string) {
    if (!NAME.test(name)) throw new Error("Invalid skill name");
    const item = (await this.selected()).get(name);
    if (!item) throw new Error(`Unknown skill: ${name}`);
    const rel = safeRelative(path);
    if (!SUPPORT.has(rel.split(sep)[0]!))
      throw new Error("Supporting file path is not allowed");
    return readNoFollow(join(item.dir, rel), await realpath(item.dir));
  }
  private async controlled(name: string) {
    if (!this.controlledRoot) throw new Error("No controlled root configured");
    if (!NAME.test(name)) throw new Error("Invalid skill name");
    const lexical = resolve(this.controlledRoot);
    const ls = await lstat(lexical);
    if (ls.isSymbolicLink() || !ls.isDirectory())
      throw new Error(
        "Controlled root must be a real directory, not a symlink",
      );
    const canonical = await realpath(lexical);
    if (canonical !== lexical)
      throw new Error("Controlled root or ancestor resolves through a symlink");
    return join(canonical, name);
  }
  async create(name: string, text: string, files: Record<string, string> = {}) {
    const target = await this.controlled(name),
      p = parse(text);
    if (p.name !== name) throw new Error("Skill name mismatch");
    try {
      await lstat(target);
      throw new Error("Skill already exists");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await this.writeTree(target, text, files);
    return this.metadata({
      source: "workspace",
      dir: target,
      text,
      parsed: p,
      support: posixKeyed(files),
      digest: digest(text, posixKeyed(files)),
    });
  }
  async update(
    name: string,
    text: string,
    options: { expectedChecksum?: string; files?: Record<string, string> } = {},
  ) {
    const target = await this.controlled(name),
      base = await realpath(target);
    if ((await lstat(target)).isSymbolicLink() || base !== target)
      throw new Error("Symlink target rejected");
    const current = await readNoFollow(
        join(target, "SKILL.md"),
        base,
        MAX_MANIFEST,
      ),
      currentFiles = await supportFiles(target, base),
      currentDigest = digest(current, currentFiles);
    if (options.expectedChecksum && options.expectedChecksum !== currentDigest)
      throw new Error("Skill checksum pin mismatch");
    const p = parse(text);
    if (p.name !== name) throw new Error("Skill name mismatch");
    const id = randomUUID(),
      temp = `${target}.tmp-${id}`,
      backup = `${target}.bak-${id}`;
    await this.writeTree(temp, text, options.files ?? {});
    let moved = false;
    try {
      await rename(target, backup);
      moved = true;
      await rename(temp, target);
      await syncDir(dirname(target));
      await rm(backup, { recursive: true });
    } catch (e) {
      await rm(temp, { recursive: true, force: true });
      if (moved) {
        try {
          await rm(target, { recursive: true, force: true });
          await rename(backup, target);
        } catch {}
      }
      throw e;
    }
    const sf = posixKeyed(options.files ?? {});
    return this.metadata({
      source: "workspace",
      dir: target,
      text,
      parsed: p,
      support: sf,
      digest: digest(text, sf),
    });
  }
  private async writeTree(
    target: string,
    text: string,
    files: Record<string, string>,
  ) {
    await mkdir(target, { recursive: false });
    try {
      const all = new Map(Object.entries(files));
      if (all.size > MAX_FILES)
        throw new Error("Supporting file count limit exceeded");
      for (const [path, value] of all) {
        const rel = safeRelative(path);
        if (
          !SUPPORT.has(rel.split(sep)[0]!) ||
          Buffer.byteLength(value) > MAX_FILE
        )
          throw new Error("Supporting file path or size is not allowed");
      }
      const values = [["SKILL.md", text] as const, ...all];
      for (const [path, value] of values) {
        const file = join(target, path);
        await mkdir(dirname(file), { recursive: true });
        const fh = await open(
          file,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await fh.writeFile(value);
          await fh.sync();
        } finally {
          await fh.close();
        }
      }
      await syncDir(target);
    } catch (e) {
      await rm(target, { recursive: true, force: true });
      throw e;
    }
  }
}

// Directory fsync is a POSIX durability refinement. Windows cannot sync
// a directory handle and some filesystems refuse it; only those specific
// failures are tolerated so real I/O errors still propagate.
const SYNC_DIR_UNSUPPORTED = new Set(["EPERM", "EISDIR", "ENOTSUP", "EINVAL"]);
async function syncDir(path: string) {
  let dh;
  try {
    dh = await open(path, constants.O_RDONLY);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (SYNC_DIR_UNSUPPORTED.has(code) || code === "EACCES") return;
    throw e;
  }
  try {
    await dh.sync();
  } catch (e) {
    if (!SYNC_DIR_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? ""))
      throw e;
  } finally {
    await dh.close();
  }
}
