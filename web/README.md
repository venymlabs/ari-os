# @ari-os/web — ARI OS Control

The operator console. Vite + React 19, no component library, no CSS framework —
the design system is hand-built in `src/styles/`.

**This directory is its own npm package on purpose.** ARI OS ships as a single
server package whose production dependencies are deliberately tiny and sit under
a CI `npm audit --omit=dev` gate. React, Vite and the browser toolchain live
here instead, are installed here, and are built and audited here. Nothing in
`web/` is imported by `src/`, and nothing in `src/` is imported by `web/`.

```bash
npm --prefix web install
npm --prefix web run dev         # http://127.0.0.1:5251
npm --prefix web run typecheck
npm --prefix web run build       # → web/dist
npm --prefix web run verify      # typecheck + build
```

Port 5251, not 5250 — 5250 belongs to the sibling ARI OS marketing site.

## The data seam

The app renders **only** from `DashboardSnapshot` and acts **only** through
`DashboardSource`, both in [`src/data/types.ts`](src/data/types.ts). No view,
component or hook imports a fixture or calls `fetch`.

```
src/data/
  types.ts          ← the contract: view models + the DashboardSource port
  source.ts         ← THE SEAM. one export, one line to change.
  fixture-source.ts ← in-browser simulation (default)
  http-source.ts    ← REST + SSE adapter, endpoint contract in its header
  fixtures.ts       ← the simulated data itself
```

`source.ts` today:

```ts
export const source: DashboardSource = API_BASE
  ? createHttpSource(API_BASE)      // VITE_ARI_API is set
  : createFixtureSource();          // otherwise: simulated
```

**To go live:** set `VITE_ARI_API` (e.g. `http://127.0.0.1:8787/api`) and
implement the endpoints listed at the top of `http-source.ts`. To bind a
different transport entirely — an in-process engine handle, a websocket RPC, a
Tauri command bridge — write one object satisfying `DashboardSource` and return
it from `source.ts`. Nothing above that line changes.

The rail and the status strip both read `SIMULATED` whenever the fixture source
is live, so a simulation is never mistaken for a funded wallet.

### The mirror can drift. Maintain it by hand.

The view models **mirror** — and deliberately do not import —
[`src/kernel/contracts.ts`](../src/kernel/contracts.ts), `src/kernel/errors.ts`
and `src/kernel/money.ts`. That keeps `bigint`, node types and the Solana SDKs
out of the browser bundle, and keeps this package's dependency graph separate
from the server's.

The price is that **nothing enforces the mirror**. No shared type, no structural
test, no build step fails when the kernel changes. Add a `GuardCode`, add a
field to `TradeIntent`, rename a `TradeState`, and this app keeps compiling
while quietly telling the operator something that is no longer true.

So the rule is: **when you touch `src/kernel/contracts.ts`, come back to
`src/data/types.ts`.** Every block there names its source of truth, and the file
header lists the divergences that are deliberate — including the perp/LP
`IntentKind`s that are ahead of the kernel, the UI-only `reconciler.sweep`
activity kind, and the strategy/signal types that mirror packages not yet ported
into this repo.

**Money rule:** token quantities are never `number`. They are base-unit integers
carried as decimal strings (the same convention `JournalEvent` uses for
bigints), paired with `decimals`. Only USD estimates — already lossy — are
numbers. Display helpers live in `src/lib/format.ts`.

## Design

The ARI OS design language, locked: obsidian `#050706`, bone `#eef1e9`, acid
`#b6ff36`. Inter 500 at `-0.05em`, Instrument Serif italic as tension, IBM Plex
Mono for all machine state. Oversized asymmetric editorial type against strict
1px technical grids. Tokens live in `src/styles/tokens.css`.

The three accents are semantic, not decorative:

| token      | meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `--model`  | the untrusted, probabilistic side — what the LLM asked for      |
| `--hazard` | the boundary itself, and anything refused or out of range       |
| `--acid`   | the deterministic host — passed, armed, in range, confirmed     |

The standing thesis — **the model proposes, the kernel disposes** — sits in the
rail on every screen. The Approvals view is that thesis rendered literally: the
model's ask in the blue zone, the kernel's re-validated verdict in the host
zone, and the hazard rule between them that the model cannot cross.

## Views

| # | view | what it is for |
| - | ---- | -------------- |
| 01 | Overview | system arm, kill switch, spend-cap ledgers, in-flight trades |
| 02 | Positions | spot, perps (liquidation distance), Meteora DLMM bins |
| 03 | **Approvals** | the centrepiece — the pending-intent queue and the boundary |
| 04 | Activity | the append-only journal and the reconciler |
| 05 | Strategies | autonomous runners; they hold no privileges |
| 06 | Signals | the pump.fun tape and rug heat — model input, never a guard |
