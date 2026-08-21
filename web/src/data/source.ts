/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE SEAM. This is the only file that changes when the backend lands.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Everything the dashboard renders flows through the `DashboardSource` port in
 * `./types.ts`. No view, component, or hook imports a fixture or calls `fetch`.
 *
 * TODAY  — with no `VITE_ARI_API` set, the app runs the in-browser simulation
 *          in `./fixture-source.ts`. The rail and the status strip both say
 *          SIMULATED so nobody mistakes it for a funded wallet.
 *
 * LIVE   — set `VITE_ARI_API` (e.g. `http://127.0.0.1:8787/api`) and the app
 *          talks to a real ARI OS control plane through `./http-source.ts`. The
 *          endpoint contract is documented at the top of that file.
 *
 * OTHER  — to bind directly to a different transport (a Tauri command bridge, a
 *          websocket RPC, the engine's in-process handle), write one object
 *          satisfying `DashboardSource` and return it below. Nothing above this
 *          line needs to know.
 *
 * As `src/perps/` and `src/pools/` land, the only surfaces that need to grow
 * are `PerpPosition` / `DlmmPosition` / `IntentView.legs` in `./types.ts` — the
 * components read those shapes and nothing else.
 */

import { createFixtureSource } from './fixture-source';
import { createHttpSource } from './http-source';
import type { DashboardSource } from './types';

const API_BASE = (import.meta.env['VITE_ARI_API'] as string | undefined)?.trim();

export const source: DashboardSource = API_BASE ? createHttpSource(API_BASE) : createFixtureSource();
