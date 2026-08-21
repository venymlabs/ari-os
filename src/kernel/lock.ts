/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS (error text
 * rebranded; behaviour unchanged).
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

/**
 * A real single-instance boot lock — the mechanism the kernel store's cap-safety
 * assumes. The reserve→settle transaction is only atomic *within one process*;
 * two engines sharing the same SQLite file (WAL allows concurrent connections)
 * could each pass the cap check before the other's reservation row is visible,
 * silently bypassing the spend cap. This lock makes "one writer per home dir" an
 * enforced invariant instead of an unwritten assumption.
 *
 * Implementation: an exclusive-create lockfile (`open` with `wx`) holding the
 * owning pid. A leftover file from a crashed process is reclaimed only when its
 * pid is provably dead — never on a timer, so a slow-but-alive engine is never
 * stolen from under.
 */
export class ProcessLock {
  #path: string;
  #fd: number | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  /** Acquire the lock or throw if another *live* process already holds it. */
  acquire(): void {
    try {
      this.#create();
    } catch (err) {
      if (!isEexist(err)) throw err;
      // A lockfile exists. A live holder (including another lock in THIS process)
      // is a real conflict; only a provably-dead owner is reclaimable. A live
      // holder always wrote a valid pid, so an unreadable pid is treated as stale.
      const holder = this.#readPid();
      if (holder !== null && pidAlive(holder)) {
        throw new LockHeldError(this.#path, holder);
      }
      // Stale (dead or pid-less owner) — remove and retry once.
      rmSync(this.#path, { force: true });
      this.#create();
    }
  }

  /** Release the lock. Safe to call more than once. */
  release(): void {
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {
        /* already closed */
      }
      this.#fd = null;
    }
    rmSync(this.#path, { force: true });
  }

  #create(): void {
    const fd = openSync(this.#path, "wx");
    writeSync(fd, `${process.pid}\n`);
    this.#fd = fd;
  }

  #readPid(): number | null {
    try {
      const raw = readFileSync(this.#path, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
}

export class LockHeldError extends Error {
  readonly heldByPid: number;
  constructor(path: string, pid: number) {
    super(
      `another ARI OS kernel instance (pid ${pid}) already holds the lock at ${path}`,
    );
    this.name = "LockHeldError";
    this.heldByPid = pid;
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "EEXIST"
  );
}

/** True iff a process with this pid is currently alive (signal 0 probes without killing). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead); EPERM = alive but not ours to signal.
    return (err as { code?: string }).code === "EPERM";
  }
}
