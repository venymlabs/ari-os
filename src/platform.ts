import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";

export const isWindows = process.platform === "win32";

/**
 * Map a filesystem-style socket path to the local IPC endpoint for this
 * platform. POSIX systems bind Unix domain sockets at real paths; Windows
 * only supports named pipes, so an absolute path is translated into a
 * pipe name derived from that path (preserving per-directory uniqueness).
 */
export function toIpcPath(socketPath: string): string {
  if (!isWindows) return socketPath;
  if (
    socketPath.startsWith("\\\\.\\pipe\\") ||
    socketPath.startsWith("\\\\?\\pipe\\")
  )
    return socketPath;
  return `\\\\.\\pipe\\${socketPath.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}`;
}

/**
 * True when POSIX permission bits are meaningful on this platform.
 * Windows reports synthetic mode bits (group/other mirror the owner), so
 * "no access for group/other" can neither be expressed nor verified via
 * st_mode there; private-file enforcement relies on directory ACLs instead.
 */
export const enforcePosixPermissions = !isWindows;

/** True when group or other have any access to the inode. */
export function permissionsAreUnsafe(stats: Pick<Stats, "mode">): boolean {
  if (!enforcePosixPermissions) return false;
  return (stats.mode & 0o077) !== 0;
}

/** Read the full contents of an inherited file descriptor, portably. */
export async function readFd(fd: number): Promise<Buffer> {
  const stream =
    fd === 0 ? process.stdin : createReadStream("", { fd, autoClose: true });
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
