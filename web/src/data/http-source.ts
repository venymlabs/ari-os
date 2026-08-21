/**
 * The live adapter. Talks to an ARI OS control plane over plain HTTP + SSE.
 *
 * NOTHING in the UI changes when this replaces the fixture source — that is the
 * point of `DashboardSource`. The endpoints below are the contract this app
 * expects; implement them on the engine's local HTTP surface (`src/api/`) and
 * set `VITE_ARI_API`.
 *
 *   GET  {base}/snapshot                 → DashboardSnapshot (JSON)
 *   GET  {base}/stream                   → text/event-stream of DashboardSnapshot
 *   POST {base}/approvals/:id/decide     { decision: 'approve' | 'reject' } → DecisionResult
 *   POST {base}/policy/kill-switch       { engaged: boolean }
 *   POST {base}/policy/execution         { enabled: boolean }
 *   POST {base}/strategies/:id/status    { status: StrategyStatus }
 *
 * bigints must arrive as decimal strings (same convention as `JournalEvent`),
 * and every field must be projected through the view models in `./types.ts` —
 * which are a hand-maintained mirror of `src/kernel/contracts.ts`. Read the
 * drift warning at the top of that file before implementing this server-side.
 */

import type {
  ApprovalDecision,
  DashboardSnapshot,
  DashboardSource,
  DecisionResult,
  StrategyStatus,
} from './types';

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

export function createHttpSource(baseUrl: string): DashboardSource {
  const base = baseUrl.replace(/\/+$/, '');

  return {
    id: 'http',
    label: base,
    simulated: false,

    async getSnapshot() {
      const res = await fetch(`${base}/snapshot`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — /snapshot`);
      return (await res.json()) as DashboardSnapshot;
    },

    subscribe(listener) {
      let stopped = false;
      let es: EventSource | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const poll = (): void => {
        if (pollTimer) return;
        pollTimer = setInterval(() => {
          void fetch(`${base}/snapshot`, { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (!stopped && j) listener(j as DashboardSnapshot);
            })
            .catch(() => undefined);
        }, 2_000);
      };

      try {
        es = new EventSource(`${base}/stream`, { withCredentials: true });
        es.onmessage = (ev: MessageEvent<string>) => {
          if (stopped) return;
          try {
            listener(JSON.parse(ev.data) as DashboardSnapshot);
          } catch {
            /* a malformed frame must not kill the stream */
          }
        };
        // fall back to polling if the stream never establishes or drops
        es.onerror = () => poll();
      } catch {
        poll();
      }

      return () => {
        stopped = true;
        es?.close();
        if (pollTimer) clearInterval(pollTimer);
      };
    },

    decide(approvalId: string, decision: ApprovalDecision): Promise<DecisionResult> {
      return post<DecisionResult>(`${base}/approvals/${encodeURIComponent(approvalId)}/decide`, { decision });
    },

    async setKillSwitch(engaged: boolean) {
      await post(`${base}/policy/kill-switch`, { engaged });
    },

    async setExecutionEnabled(enabled: boolean) {
      await post(`${base}/policy/execution`, { enabled });
    },

    async setStrategyStatus(strategyId: string, status: StrategyStatus) {
      await post(`${base}/strategies/${encodeURIComponent(strategyId)}/status`, { status });
    },
  };
}
