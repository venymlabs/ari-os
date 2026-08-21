/**
 * Subscription plumbing. The store owns exactly one `DashboardSource`
 * subscription for the whole app; views read snapshots and never fetch.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { source } from '../data/source';
import type { DashboardSnapshot } from '../data/types';

let current: DashboardSnapshot | null = null;
let started = false;
const subs = new Set<() => void>();

function ensureStarted(): void {
  if (started) return;
  started = true;
  source.subscribe((snap) => {
    current = snap;
    for (const fn of subs) fn();
  });
}

function subscribe(onChange: () => void): () => void {
  ensureStarted();
  subs.add(onChange);
  return () => {
    subs.delete(onChange);
  };
}

const read = (): DashboardSnapshot | null => current;

export function useSnapshot(): DashboardSnapshot | null {
  return useSyncExternalStore(subscribe, read, read);
}

/** A ticking wall clock, for countdowns and "x ago" labels. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ── toasts ──────────────────────────────────────────────────────────────────

export interface Toast {
  readonly id: string;
  readonly ok: boolean;
  readonly text: string;
}

const toastSubs = new Set<() => void>();
let toasts: readonly Toast[] = [];
let toastSeq = 0;

export function pushToast(ok: boolean, text: string): void {
  toastSeq += 1;
  const id = `t${toastSeq}`;
  toasts = [...toasts, { id, ok, text }];
  for (const fn of toastSubs) fn();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    for (const fn of toastSubs) fn();
  }, 5_200);
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    useCallback((cb: () => void) => {
      toastSubs.add(cb);
      return () => {
        toastSubs.delete(cb);
      };
    }, []),
    () => toasts,
    () => toasts,
  );
}
