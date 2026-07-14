import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Best-effort removal of a test temp directory.
 *
 * POSIX unlinks files that still have open handles, but Windows locks
 * them (EBUSY/EPERM). Several suites intentionally keep SQLite
 * connections open across assertions; failing the test because the OS
 * temp dir could not be reclaimed immediately would test the platform,
 * not the code under test.
 */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")
    )
      return;
    throw e;
  }
}

/** True when this process may create symlinks (Windows needs privilege). */
export function canSymlink(): boolean {
  if (process.platform !== "win32") return true;
  const dir = mkdtempSync(join(tmpdir(), "symlink-probe-"));
  try {
    symlinkSync(dir, join(dir, "probe"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    removeDir(dir);
  }
}

/** True when POSIX permission bits are enforceable on this platform. */
export const posixPermissions = process.platform !== "win32";

/** Platform-correct npm invocation target for child-process tests. */
export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/** Extra spawn options npm needs on Windows (cmd shim requires a shell). */
export const npmSpawnOptions =
  process.platform === "win32" ? { shell: true as const } : {};
