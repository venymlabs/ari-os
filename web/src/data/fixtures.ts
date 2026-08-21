/**
 * Fixture data. Realistic shapes, realistic magnitudes, realistic failure modes.
 * Nothing here is imported by a view — only by `fixture-source.ts`.
 */

import { mulberry32 } from '../lib/format';
import type {
  ActivityEntry,
  Amount,
  CapLedger,
  DlmmPosition,
  GuardCheck,
  Holding,
  InflightTrade,
  PendingApproval,
  PerpPosition,
  StrategyView,
  SystemState,
  TapeRow,
  TokenSignalView,
  WalletView,
} from './types';

export const T0 = Date.now();
export const MIN = 60_000;

export const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  MOTH: '7xKQ4vHm2bTqnRfLpDwAzGyc9UeVsN3kJdRb5tPqCpump',
  GRIN: 'Ck9zLmA4vXbRp2QsYtNfEd8HwUj3TgMv6BxKcQ1Wpump',
  LUMEN: '4bXnQhVtWs7Yg1MpRkCdZfLu3EoAv9NjTyH2Bx6Kpump',
} as const;

export const WALLET_ADDRESS = 'A3tK9vQmXpLd7RfWbYs2NcHuEj4Zg6TnPk1BvR8QwSxu';

const amt = (mint: string, symbol: string, decimals: number, base: string): Amount => ({
  mint,
  symbol,
  decimals,
  base,
});

// ── system ──────────────────────────────────────────────────────────────────

export const BASE_BLOCK_HEIGHT = 291_884_017;
export const BASE_SLOT = 318_442_901;

export function makeSystem(now: number, blockHeight: number, slot: number): SystemState {
  return {
    executionEnabled: true,
    killSwitch: false,
    agentPhase: 'awaiting_approval',
    maxSlippageBps: 150,
    priorityFeeMaxLamports: '2000000',
    priorityFeeMaxBps: 40,
    allowToken2022: false,
    mintAllowlistSize: null,
    mintDenylistSize: 34,
    network: 'solana / mainnet-beta',
    rpcLabel: 'helius · rpc-01',
    modelLabel: 'claude-sonnet-4.6 · byok',
    bootedAt: T0 - 4 * 3600_000 - 22 * MIN,
    lastHeartbeatAt: now - 1_400,
    reconciler: {
      running: true,
      lastSweepAt: now - 3_200,
      pending: 2,
      blockHeight,
      slot,
    },
  };
}

// ── wallet & holdings ───────────────────────────────────────────────────────

export const HOLDINGS: readonly Holding[] = [
  {
    amount: amt(MINTS.SOL, 'SOL', 9, '18420931442'),
    usd: 3_142.77,
    costUsd: 2_806.4,
    pnlPct: 11.99,
    provenance: 'user',
    token2022: false,
  },
  {
    amount: amt(MINTS.USDC, 'USDC', 6, '3204110000'),
    usd: 3_204.11,
    costUsd: 3_204.11,
    pnlPct: 0,
    provenance: 'user',
    token2022: false,
  },
  {
    amount: amt(MINTS.JUP, 'JUP', 6, '12480400000'),
    usd: 5_616.18,
    costUsd: 6_240.2,
    pnlPct: -10.0,
    provenance: 'watchlist',
    token2022: false,
  },
  {
    amount: amt(MINTS.WIF, 'WIF', 6, '214600000'),
    usd: 402.68,
    costUsd: 318.9,
    pnlPct: 26.27,
    provenance: 'watchlist',
    token2022: false,
  },
  {
    amount: amt(MINTS.JTO, 'JTO', 9, '840120000000'),
    usd: 1_814.66,
    costUsd: 2_012.4,
    pnlPct: -9.83,
    provenance: 'watchlist',
    token2022: false,
  },
  {
    amount: amt(MINTS.BONK, 'BONK', 5, '4120000000000'),
    usd: 741.6,
    costUsd: 903.2,
    pnlPct: -17.89,
    provenance: 'untrusted',
    token2022: false,
  },
];

export const WALLET: WalletView = {
  address: WALLET_ADDRESS,
  label: 'on-machine keystore · scrypt → aes-256-gcm',
  totalUsd: HOLDINGS.reduce((n, h) => n + h.usd, 0),
  change24hPct: 2.41,
  holdings: HOLDINGS,
};

// ── caps ────────────────────────────────────────────────────────────────────

export function makeCaps(now: number): readonly CapLedger[] {
  return [
    {
      bucket: 'sol',
      symbol: 'SOL',
      decimals: 9,
      meters: [
        { window: 'perTrade', cap: '2500000000', used: '0', resetsAt: null },
        { window: 'perHour', cap: '8000000000', used: '3150000000', resetsAt: now + 21 * MIN },
        { window: 'perDay', cap: '25000000000', used: '11900000000', resetsAt: now + 9 * 3600_000 },
      ],
    },
    {
      bucket: 'usdc',
      symbol: 'USDC',
      decimals: 6,
      meters: [
        { window: 'perTrade', cap: '500000000', used: '0', resetsAt: null },
        { window: 'perHour', cap: '1500000000', used: '260000000', resetsAt: now + 21 * MIN },
        { window: 'perDay', cap: '5000000000', used: '1840000000', resetsAt: now + 9 * 3600_000 },
      ],
    },
  ];
}

// ── perps ───────────────────────────────────────────────────────────────────

export const PERPS: readonly PerpPosition[] = [
  {
    id: 'perp-drift-solperp',
    venue: 'Drift',
    market: 'SOL-PERP',
    side: 'long',
    sizeUsd: 5_460.0,
    entryPrice: 162.4,
    markPrice: 170.62,
    leverage: 3.2,
    liquidationPrice: 128.9,
    liquidationDistancePct: 24.45,
    marginUsd: 1_706.25,
    unrealizedUsd: 276.4,
    fundingRateBps1h: 1.4,
    fundingPaidUsd: -18.32,
    openedAt: T0 - 31 * 3600_000,
  },
  {
    id: 'perp-jup-ethperp',
    venue: 'Jupiter Perps',
    market: 'ETH-PERP',
    side: 'short',
    sizeUsd: 3_120.0,
    entryPrice: 3_048.0,
    markPrice: 3_186.5,
    leverage: 5.0,
    liquidationPrice: 3_442.1,
    liquidationDistancePct: 8.02,
    marginUsd: 624.0,
    unrealizedUsd: -141.8,
    fundingRateBps1h: -0.6,
    fundingPaidUsd: 7.44,
    openedAt: T0 - 9 * 3600_000,
  },
  {
    id: 'perp-drift-jupperp',
    venue: 'Drift',
    market: 'JUP-PERP',
    side: 'long',
    sizeUsd: 890.0,
    entryPrice: 0.452,
    markPrice: 0.4501,
    leverage: 2.0,
    liquidationPrice: 0.2318,
    liquidationDistancePct: 48.5,
    marginUsd: 445.0,
    unrealizedUsd: -3.74,
    fundingRateBps1h: 0.2,
    fundingPaidUsd: -1.06,
    openedAt: T0 - 2 * 3600_000 - 40 * MIN,
  },
];

// ── Meteora DLMM ────────────────────────────────────────────────────────────

export const DLMM: readonly DlmmPosition[] = [
  {
    id: 'dlmm-sol-usdc',
    pool: 'SOL / USDC',
    venue: 'Meteora DLMM',
    binStep: 20,
    lowerBinId: 1_842,
    upperBinId: 1_878,
    activeBinId: 1_861,
    inRange: true,
    lowerPrice: 154.2,
    upperPrice: 187.9,
    currentPrice: 170.62,
    liquidityUsd: 4_280.4,
    feesEarnedUsd: 96.32,
    feesUnclaimed: [amt(MINTS.SOL, 'SOL', 9, '182400000'), amt(MINTS.USDC, 'USDC', 6, '34210000')],
    openedAt: T0 - 5 * 24 * 3600_000,
  },
  {
    id: 'dlmm-jup-sol',
    pool: 'JUP / SOL',
    venue: 'Meteora DLMM',
    binStep: 25,
    lowerBinId: 902,
    upperBinId: 934,
    activeBinId: 948,
    inRange: false,
    lowerPrice: 0.00268,
    upperPrice: 0.00301,
    currentPrice: 0.00318,
    liquidityUsd: 1_910.7,
    feesEarnedUsd: 41.08,
    feesUnclaimed: [amt(MINTS.JUP, 'JUP', 6, '184200000')],
    openedAt: T0 - 11 * 24 * 3600_000,
  },
  {
    id: 'dlmm-wif-sol',
    pool: 'WIF / SOL',
    venue: 'Meteora DLMM',
    binStep: 80,
    lowerBinId: 412,
    upperBinId: 452,
    activeBinId: 449,
    inRange: true,
    lowerPrice: 0.00842,
    upperPrice: 0.01388,
    currentPrice: 0.01342,
    liquidityUsd: 742.9,
    feesEarnedUsd: 28.74,
    feesUnclaimed: [amt(MINTS.WIF, 'WIF', 6, '2140000'), amt(MINTS.SOL, 'SOL', 9, '9200000')],
    openedAt: T0 - 2 * 24 * 3600_000,
  },
];

// ── approvals ───────────────────────────────────────────────────────────────

const g = (
  code: GuardCheck['code'],
  label: string,
  status: GuardCheck['status'],
  detail: string,
  observed: string | null = null,
  limit: string | null = null,
): GuardCheck => ({ code, label, status, detail, observed, limit });

/** The full guard ledger for a clean swap, in kernel evaluation order. */
function swapGuardsClean(slippageBps: number, feeLamports: string): readonly GuardCheck[] {
  return [
    g('EXECUTION_DISABLED', 'execution armed', 'pass', 'policy.executionEnabled = true'),
    g('KILL_SWITCH', 'kill switch released', 'pass', 'policy.killSwitch = false'),
    g('INVALID_INTENT', 'intent structurally valid', 'pass', 'kind=swap · all required fields decoded'),
    g('MINT_DENIED', 'mints off denylist', 'pass', 'allowlist=∅ (open) · denylist 34 entries'),
    g('TOKEN2022_UNSUPPORTED', 'spl-token program', 'pass', 'both mints on TokenkegQfe…5DA · not Token-2022'),
    g('MINT_NOT_PINNED', 'provenance pinned', 'pass', 'input=user · output=watchlist'),
    g(
      'SLIPPAGE_EXCEEDED',
      'slippage within clamp',
      'pass',
      'route rebuilt at the clamped value, not the requested one',
      `${slippageBps} bps`,
      '150 bps',
    ),
    g('MIN_OUT_MISMATCH', 'min-out consistent', 'pass', 'otherAmountThreshold reproduces from outAmount × (1 − slippage)'),
    g(
      'PRIORITY_FEE_EXCEEDED',
      'priority fee capped',
      'pass',
      'min(absolute lamports, bps of notional)',
      `${feeLamports} lamports`,
      '2,000,000 lamports',
    ),
    g('CAP_EXCEEDED', 'input-leg spend cap', 'pass', 'checked against every rolling window — see the cap ledger below'),
    g('INSUFFICIENT_BALANCE', 'balance covers leg + fees', 'pass', 'read at the metal, not from the quote'),
    g('DUPLICATE_INTENT', 'idempotency key unused', 'pass', 'no prior row for this key'),
    g('SIMULATION_FAILED', 'simulation clean', 'pass', 'exact serialized bytes simulated — not an approximation'),
  ];
}

export function makeApprovals(now: number, blockHeight: number, slot: number): readonly PendingApproval[] {
  return [
    // ─────────────── 1. clean swap, approvable ───────────────
    {
      id: 'apr-01',
      tradeId: 'trd_01JQ7F2XW4K8',
      idempotencyKey: 'idm_8f31c0d94ab2e7',
      receivedAt: now - 47_000,
      source: 'swap_jupiter',
      rationale:
        'JUP is holding the 0.44 shelf on rising volume while SOL chops sideways. I want a 1.75 SOL starter — small enough that a wick does not matter, large enough to be worth managing.',
      modelLabel: 'claude-sonnet-4.6',
      intent: {
        kind: 'swap',
        summary: 'Swap 1.75 SOL → JUP',
        input: amt(MINTS.SOL, 'SOL', 9, '1750000000'),
        output: amt(MINTS.JUP, 'JUP', 6, '661842104'),
        minOut: amt(MINTS.JUP, 'JUP', 6, '651914472'),
        inputProvenance: 'user',
        outputProvenance: 'watchlist',
        routeLabel: 'Meteora DLMM → Whirlpool',
        priceImpactPct: 0.14,
        slippageBps: 150,
        priorityFeeLamports: '148000',
        landMode: 'jupiter-ultra',
        landHandle: 'ultra_9f4c1b2e-7a03-4d6f-9c51-8be207d4a1f3',
        unsignedTxDigest: 'b7d41ac0e9f3268a5c1d7e04b28f9a6c3d5e17f0',
        unsignedTxBytes: 1_232,
        recentBlockhash: '9pQx4TmKvLdRfWbYs2NcHuEj4Zg6TnPk1BvR8QwSxuA3',
        quoteContextSlot: slot - 6,
        legs: [],
      },
      guards: swapGuardsClean(150, '148,000'),
      capChecks: [
        { window: 'perTrade', bucket: 'sol', symbol: 'SOL', decimals: 9, cap: '2500000000', used: '0', would: '1750000000', ok: true },
        { window: 'perHour', bucket: 'sol', symbol: 'SOL', decimals: 9, cap: '8000000000', used: '3150000000', would: '4900000000', ok: true },
        { window: 'perDay', bucket: 'sol', symbol: 'SOL', decimals: 9, cap: '25000000000', used: '11900000000', would: '13650000000', ok: true },
      ],
      simulation: {
        ok: true,
        unitsConsumed: 118_402,
        atSlot: slot - 4,
        err: null,
        logs: [
          'Program JUP6Lk…4kFN invoke [1]',
          'Program log: Instruction: SharedAccountsRoute',
          'Program LBUZKh…q1Bs invoke [2]',
          'Program log: swap succeeded · out 661,842,104',
          'Program JUP6Lk…4kFN consumed 118402 of 400000 compute units',
        ],
      },
      expiry: { lastValidBlockHeight: blockHeight + 118, currentBlockHeight: blockHeight, expiresAt: now + 165_000 },
      verdict: 'clear',
    },

    // ─────────────── 2. refused: two guards failed ───────────────
    {
      id: 'apr-02',
      tradeId: 'trd_01JQ7F5RB9M2',
      idempotencyKey: 'idm_c04e1b7fa8d365',
      receivedAt: now - 12_000,
      source: 'swap_jupiter',
      rationale:
        'MOTH just crossed 40 SOL of net inflow in four minutes and the deployer wallet has stopped selling. This is the kind of entry that does not wait — I want 12.4 SOL in before the next candle.',
      modelLabel: 'claude-sonnet-4.6',
      intent: {
        kind: 'swap',
        summary: 'Swap 12.4 SOL → MOTH',
        input: amt(MINTS.SOL, 'SOL', 9, '12400000000'),
        output: amt(MINTS.MOTH, 'MOTH', 6, '84210442901'),
        minOut: amt(MINTS.MOTH, 'MOTH', 6, '81282577201'),
        inputProvenance: 'user',
        outputProvenance: 'untrusted',
        routeLabel: 'Pump AMM (single hop)',
        priceImpactPct: 6.82,
        slippageBps: 150,
        priorityFeeLamports: '480000',
        landMode: 'self-rpc',
        landHandle: null,
        unsignedTxDigest: '4e10c8bd7a29f6350d81be47c9a20f6d18b3e5c7',
        unsignedTxBytes: 864,
        recentBlockhash: 'Hk2QwSxuA3tK9vQmXpLd7RfWbYs2NcHuEj4Zg6TnPk1B',
        quoteContextSlot: slot - 31,
        legs: [],
      },
      guards: [
        g('EXECUTION_DISABLED', 'execution armed', 'pass', 'policy.executionEnabled = true'),
        g('KILL_SWITCH', 'kill switch released', 'pass', 'policy.killSwitch = false'),
        g('INVALID_INTENT', 'intent structurally valid', 'pass', 'kind=swap · all required fields decoded'),
        g('MINT_DENIED', 'mints off denylist', 'pass', 'allowlist=∅ (open) · denylist 34 entries'),
        g('TOKEN2022_UNSUPPORTED', 'spl-token program', 'pass', 'both mints on TokenkegQfe…5DA · not Token-2022'),
        g(
          'MINT_NOT_PINNED',
          'provenance pinned',
          'fail',
          'output mint reached the intent from model/metadata, not from you or your watchlist. An operator must pin it by hand.',
          'output = untrusted',
          'user | watchlist',
        ),
        g('SLIPPAGE_EXCEEDED', 'slippage within clamp', 'pass', 'requested 900 bps → hard-clamped to policy before the route was built', '150 bps', '150 bps'),
        g('MIN_OUT_MISMATCH', 'min-out consistent', 'pass', 'otherAmountThreshold reproduces from outAmount × (1 − slippage)'),
        g('PRIORITY_FEE_EXCEEDED', 'priority fee capped', 'pass', 'min(absolute lamports, bps of notional)', '480,000 lamports', '2,000,000 lamports'),
        g(
          'CAP_EXCEEDED',
          'input-leg spend cap',
          'fail',
          'the per-trade window is denominated in SOL — what leaves the wallet. No oracle sits in this path, so the price of MOTH is irrelevant to the refusal.',
          '12.4 SOL',
          '2.5 SOL / trade',
        ),
        g('INSUFFICIENT_BALANCE', 'balance covers leg + fees', 'pass', 'read at the metal, not from the quote'),
        g('DUPLICATE_INTENT', 'idempotency key unused', 'pass', 'no prior row for this key'),
        g('SIMULATION_FAILED', 'simulation clean', 'skipped', 'not reached — a static guard refused before simulation'),
      ],
      capChecks: [
        { window: 'perTrade', bucket: 'sol', symbol: 'SOL', decimals: 9, cap: '2500000000', used: '0', would: '12400000000', ok: false },
        { window: 'perHour', bucket: 'sol', symbol: 'SOL', decimals: 9, cap: '8000000000', used: '3150000000', would: '15550000000', ok: false },
        { window: 'perDay', bucket: 'sol', symbol: 'SOL', decimals: 9, cap: '25000000000', used: '11900000000', would: '24300000000', ok: true },
      ],
      simulation: {
        ok: false,
        unitsConsumed: null,
        atSlot: null,
        err: 'a static guard refused first — these exact bytes were never submitted to an RPC',
        logs: ['simulation not reached — refused by static guards'],
      },
      expiry: { lastValidBlockHeight: blockHeight + 141, currentBlockHeight: blockHeight, expiresAt: now + 240_000 },
      verdict: 'blocked',
    },

    // ─────────────── 3. non-swap intent, approvable, expiring ───────────────
    {
      id: 'apr-03',
      tradeId: 'trd_01JQ7F8CD1P7',
      idempotencyKey: 'idm_2a7d90fe4c1b83',
      receivedAt: now - 90_000,
      source: 'perp_open_drift',
      rationale:
        'Funding on SOL-PERP has been positive but thin, and spot is leading. A 3× long financed with 250 USDC keeps the liquidation more than twenty percent away, which is the only number I actually care about here.',
      modelLabel: 'claude-sonnet-4.6',
      intent: {
        kind: 'perp_open',
        summary: 'Open SOL-PERP 3× long · 250 USDC margin',
        input: amt(MINTS.USDC, 'USDC', 6, '250000000'),
        output: amt(MINTS.SOL, 'SOL-PERP', 9, '4396000000'),
        minOut: amt(MINTS.SOL, 'SOL-PERP', 9, '4352000000'),
        inputProvenance: 'user',
        outputProvenance: 'user',
        routeLabel: 'Drift v2 · perp market 0',
        priceImpactPct: 0.09,
        slippageBps: 100,
        priorityFeeLamports: '96000',
        landMode: 'self-rpc',
        landHandle: null,
        unsignedTxDigest: 'ff2b6a14c03d98e7521a4bd0e6c38f9721a45db0',
        unsignedTxBytes: 1_048,
        recentBlockhash: 'Ln7Zg6TnPk1BvR8QwSxuA3tK9vQmXpLd7RfWbYs2NcHu',
        quoteContextSlot: slot - 11,
        legs: [
          ['market', 'SOL-PERP · index 0'],
          ['side', 'LONG'],
          ['leverage', '3.00×'],
          ['notional', '$750.00'],
          ['est. entry', '$170.62'],
          ['est. liquidation', '$121.05  (−29.05%)'],
          ['order type', 'market · IOC'],
        ],
      },
      guards: [
        g('EXECUTION_DISABLED', 'execution armed', 'pass', 'policy.executionEnabled = true'),
        g('KILL_SWITCH', 'kill switch released', 'pass', 'policy.killSwitch = false'),
        g('INVALID_INTENT', 'intent structurally valid', 'pass', 'kind=perp_open · market + side + margin decoded from the tx'),
        g('MINT_DENIED', 'mints off denylist', 'pass', 'collateral USDC is on the pinned quote set'),
        g('TOKEN2022_UNSUPPORTED', 'spl-token program', 'pass', 'USDC on TokenkegQfe…5DA'),
        g('MINT_NOT_PINNED', 'provenance pinned', 'pass', 'input=user · output=user'),
        g('SLIPPAGE_EXCEEDED', 'slippage within clamp', 'pass', 'order built at the clamped value', '100 bps', '150 bps'),
        g('MIN_OUT_MISMATCH', 'min-out consistent', 'pass', 'worst-case fill size reproduces from the oracle band'),
        g('PRIORITY_FEE_EXCEEDED', 'priority fee capped', 'pass', 'min(absolute lamports, bps of notional)', '96,000 lamports', '2,000,000 lamports'),
        g('CAP_EXCEEDED', 'input-leg spend cap', 'pass', 'margin posted is the input leg — leverage does not enlarge the cap'),
        g('INSUFFICIENT_BALANCE', 'balance covers leg + fees', 'pass', '3,204.11 USDC available'),
        g('DUPLICATE_INTENT', 'idempotency key unused', 'pass', 'no prior row for this key'),
        g('SIMULATION_FAILED', 'simulation clean', 'pass', 'exact serialized bytes simulated — not an approximation'),
      ],
      capChecks: [
        { window: 'perTrade', bucket: 'usdc', symbol: 'USDC', decimals: 6, cap: '500000000', used: '0', would: '250000000', ok: true },
        { window: 'perHour', bucket: 'usdc', symbol: 'USDC', decimals: 6, cap: '1500000000', used: '260000000', would: '510000000', ok: true },
        { window: 'perDay', bucket: 'usdc', symbol: 'USDC', decimals: 6, cap: '5000000000', used: '1840000000', would: '2090000000', ok: true },
      ],
      simulation: {
        ok: true,
        unitsConsumed: 204_118,
        atSlot: slot - 9,
        err: null,
        logs: [
          'Program dRiftyH…8Cc4 invoke [1]',
          'Program log: Instruction: PlacePerpOrder',
          'Program log: oracle price 170.62 · margin ratio 0.333',
          'Program dRiftyH…8Cc4 consumed 204118 of 400000 compute units',
        ],
      },
      expiry: { lastValidBlockHeight: blockHeight + 42, currentBlockHeight: blockHeight, expiresAt: now + 78_000 },
      verdict: 'clear',
    },
  ];
}

// ── inflight ────────────────────────────────────────────────────────────────

export function makeInflight(now: number): readonly InflightTrade[] {
  return [
    {
      id: 'trd_01JQ7EYH3N6V',
      state: 'sent',
      signature: '5xKq9mR2vT8pLdNfWbYs3EoAv7NjTyH2Bx6KcQ1WpDzGh4UeVsN3kJdRb5tPqCmA',
      summary: 'Swap 0.85 SOL → JTO',
      since: now - 8_400,
      blockHeadroom: 94,
    },
    {
      id: 'trd_01JQ7EZ0P4T1',
      state: 'reserved',
      signature: null,
      summary: 'Claim DLMM fees · SOL/USDC',
      since: now - 2_100,
      blockHeadroom: 148,
    },
  ];
}

// ── activity journal ────────────────────────────────────────────────────────

interface Seed {
  readonly offset: number;
  readonly kind: ActivityEntry['kind'];
  readonly level: ActivityEntry['level'];
  readonly tradeId: string | null;
  readonly text: string;
  readonly signature?: string;
  readonly fields?: readonly (readonly [string, string])[];
}

const SEEDS: readonly Seed[] = [
  { offset: 8_400, kind: 'trade.sent', level: 'info', tradeId: 'trd_01JQ7EYH3N6V', text: 'broadcast accepted by leader — awaiting confirmation', signature: '5xKq9mR2…PqCmA', fields: [['land', 'jupiter-ultra'], ['retries', '0']] },
  { offset: 9_100, kind: 'trade.signed', level: 'info', tradeId: 'trd_01JQ7EYH3N6V', text: 'one-time signing envelope consumed · wire persisted before broadcast', fields: [['bytes', '1,184'], ['signer', 'isolated']] },
  { offset: 9_800, kind: 'trade.simulated', level: 'pass', tradeId: 'trd_01JQ7EYH3N6V', text: 'simulation ok · 121,884 CU', fields: [['slot', '318,442,884']] },
  { offset: 10_400, kind: 'trade.reserved', level: 'info', tradeId: 'trd_01JQ7EYH3N6V', text: 'reserved 0.85 SOL against the hourly window', fields: [['bucket', 'sol'], ['used→', '3.15 SOL / 8.00']] },
  { offset: 11_000, kind: 'intent.received', level: 'info', tradeId: 'trd_01JQ7EYH3N6V', text: 'swap_jupiter proposed 0.85 SOL → JTO', fields: [['source', 'swap_jupiter']] },
  { offset: 92_000, kind: 'trade.confirmed', level: 'pass', tradeId: 'trd_01JQ7EW8K2R9', text: 'confirmed · received 2,884.10 JUP against a 2,841.22 floor', signature: '3nRt7vQ2…Xm4Bp', fields: [['slippage', '38 bps'], ['slot', '318,442,644']] },
  { offset: 118_000, kind: 'guard.rejected', level: 'fail', tradeId: 'trd_01JQ7EVB0C3M', text: 'CAP_EXCEEDED — 9.20 SOL would breach the 8.00 SOL hourly window', fields: [['guard', 'CAP_EXCEEDED'], ['bucket', 'sol']] },
  { offset: 141_000, kind: 'intent.received', level: 'info', tradeId: 'trd_01JQ7EVB0C3M', text: 'swap_jupiter proposed 9.20 SOL → WIF', fields: [['source', 'swap_jupiter']] },
  { offset: 186_000, kind: 'reconciler.sweep', level: 'info', tradeId: null, text: 'sweep · 2 in flight · 0 stale · 0 orphaned reservations', fields: [['height', '291,883,894']] },
  { offset: 240_000, kind: 'trade.confirmed', level: 'pass', tradeId: 'trd_01JQ7ET4Y7H2', text: 'confirmed · DCA slice 7/24 filled at 170.11', signature: '8qLm3wE5…Nv2Kc', fields: [['strategy', 'dca-sol-usdc']] },
  { offset: 292_000, kind: 'guard.rejected', level: 'fail', tradeId: 'trd_01JQ7ESR9J5F', text: 'MINT_NOT_PINNED — output mint arrived from model metadata; an operator must pin it', fields: [['guard', 'MINT_NOT_PINNED'], ['mint', '7xKQ…pump']] },
  { offset: 318_000, kind: 'trade.dryrun', level: 'info', tradeId: 'trd_01JQ7ESD2W8K', text: 'dry-run only — quote card rendered, nothing signed', fields: [['reason', 'preview']] },
  { offset: 402_000, kind: 'trade.failed', level: 'warn', tradeId: 'trd_01JQ7ER1M6B4', text: 'CONFIRM_TIMEOUT — blockhash expired at height 291,883,612. Terminal: the kernel will not re-sign this intent.', fields: [['guard', 'CONFIRM_TIMEOUT']] },
  { offset: 446_000, kind: 'trade.sent', level: 'info', tradeId: 'trd_01JQ7ER1M6B4', text: 'broadcast accepted by leader — awaiting confirmation', signature: '2vBn8xC1…Qw7Ld' },
  { offset: 512_000, kind: 'reconciler.sweep', level: 'info', tradeId: null, text: 'sweep · 1 in flight · 1 expired → terminal · reservation released', fields: [['height', '291,883,410']] },
  { offset: 604_000, kind: 'trade.confirmed', level: 'pass', tradeId: 'trd_01JQ7EPH4V0N', text: 'confirmed · TWAP slice 11/16 filled at 0.4498', signature: '9dFg2hJ4…Rt8Yu', fields: [['strategy', 'twap-jup-out']] },
  { offset: 702_000, kind: 'guard.rejected', level: 'fail', tradeId: 'trd_01JQ7EN9S2X7', text: 'TOKEN2022_UNSUPPORTED — mint uses the Token-2022 program; refused rather than mis-accounted', fields: [['guard', 'TOKEN2022_UNSUPPORTED']] },
  { offset: 848_000, kind: 'trade.simulated', level: 'pass', tradeId: 'trd_01JQ7EM2K8D3', text: 'simulation ok · 96,204 CU' },
  { offset: 902_000, kind: 'trade.confirmed', level: 'pass', tradeId: 'trd_01JQ7EM2K8D3', text: 'confirmed · claimed 0.182 SOL + 34.21 USDC in DLMM fees', signature: '6tYh1pK9…Zx3Vn' },
  { offset: 1_100_000, kind: 'reconciler.sweep', level: 'info', tradeId: null, text: 'sweep · 0 in flight · store consistent', fields: [['height', '291,882,930']] },
  { offset: 1_284_000, kind: 'trade.failed', level: 'fail', tradeId: 'trd_01JQ7EJ7B1Q6', text: 'SETTLE_SHORTFALL — confirmed but received 1.8% under the committed floor; flagged for review', fields: [['guard', 'SETTLE_SHORTFALL']] },
  { offset: 1_402_000, kind: 'intent.received', level: 'info', tradeId: 'trd_01JQ7EJ7B1Q6', text: 'swap_jupiter proposed 2.10 SOL → BONK', fields: [['source', 'swap_jupiter']] },
];

export function makeActivity(now: number): readonly ActivityEntry[] {
  return SEEDS.map((s, i) => ({
    id: `act-${i}`,
    at: now - s.offset,
    kind: s.kind,
    tradeId: s.tradeId,
    level: s.level,
    text: s.text,
    signature: s.signature ?? null,
    fields: s.fields ?? [],
  }));
}

// ── strategies ──────────────────────────────────────────────────────────────

export function makeStrategies(now: number): readonly StrategyView[] {
  return [
    {
      id: 'stg-dca-sol',
      kind: 'dca',
      label: 'Accumulate SOL from USDC, hourly',
      status: 'active',
      params: [
        ['input', 'USDC'],
        ['output', 'SOL'],
        ['slice', '120.00 USDC'],
        ['interval', '1h'],
        ['slices', '24'],
      ],
      nextRunAt: now + 18 * MIN,
      lastRunAt: now - 42 * MIN,
      createdAt: now - 7 * 3600_000,
      runs: 7,
      errors: 0,
      lastError: null,
      progress: { done: 7, total: 24 },
      trigger: null,
      budget: { spent: '840000000', cap: '2880000000', symbol: 'USDC', decimals: 6 },
    },
    {
      id: 'stg-twap-jup',
      kind: 'twap',
      label: 'Unwind JUP into SOL over 4 hours',
      status: 'active',
      params: [
        ['input', 'JUP'],
        ['output', 'SOL'],
        ['total', '4,800 JUP'],
        ['window', '4h'],
        ['slices', '16'],
      ],
      nextRunAt: now + 4 * MIN + 12_000,
      lastRunAt: now - 10 * MIN,
      createdAt: now - 2 * 3600_000 - 46 * MIN,
      runs: 11,
      errors: 1,
      lastError: 'slice 6: CONFIRM_TIMEOUT — retried on the next tick with a fresh blockhash',
      progress: { done: 11, total: 16 },
      trigger: null,
      budget: null,
    },
    {
      id: 'stg-trail-wif',
      kind: 'trailing_stop',
      label: 'Trail WIF 12% off the high-water mark',
      status: 'active',
      params: [
        ['asset', 'WIF'],
        ['trail', '12.00%'],
        ['high-water', '$2.084'],
        ['size', '100% of position'],
      ],
      nextRunAt: now + 46_000,
      lastRunAt: now - 74_000,
      createdAt: now - 30 * 3600_000,
      runs: 1_284,
      errors: 0,
      lastError: null,
      progress: null,
      trigger: { label: 'stop price', current: 1.876, target: 1.834, distancePct: 2.24 },
      budget: null,
    },
    {
      id: 'stg-tp-jto',
      kind: 'take_profit',
      label: 'Take 50% of JTO at $2.60',
      status: 'paused',
      params: [
        ['asset', 'JTO'],
        ['target', '$2.600'],
        ['size', '50% of position'],
        ['paused', 'by operator'],
      ],
      nextRunAt: null,
      lastRunAt: now - 5 * 3600_000,
      createdAt: now - 3 * 24 * 3600_000,
      runs: 412,
      errors: 0,
      lastError: null,
      progress: null,
      trigger: { label: 'mark price', current: 2.161, target: 2.6, distancePct: 20.31 },
      budget: null,
    },
    {
      id: 'stg-dca-bonk',
      kind: 'dca',
      label: 'Accumulate BONK, daily',
      status: 'errored',
      params: [
        ['input', 'SOL'],
        ['output', 'BONK'],
        ['slice', '0.25 SOL'],
        ['interval', '24h'],
      ],
      nextRunAt: null,
      lastRunAt: now - 19 * 3600_000,
      createdAt: now - 14 * 24 * 3600_000,
      runs: 13,
      errors: 3,
      lastError: 'MINT_NOT_PINNED — output mint provenance fell back to untrusted after a metadata refresh. Runner halted rather than asking the model to re-confirm.',
      progress: { done: 13, total: 30 },
      trigger: null,
      budget: { spent: '3250000000', cap: '7500000000', symbol: 'SOL', decimals: 9 },
    },
  ];
}

// ── signals ─────────────────────────────────────────────────────────────────

export const TAPE_TOKENS = [
  { mint: MINTS.MOTH, symbol: 'MOTH' },
  { mint: MINTS.GRIN, symbol: 'GRIN' },
  { mint: MINTS.LUMEN, symbol: 'LUMEN' },
  { mint: MINTS.WIF, symbol: 'WIF' },
  { mint: MINTS.BONK, symbol: 'BONK' },
] as const;

const TRADERS = [
  '9WzDXw', 'BqTn4v', 'Ehm2Kp', 'GnR7sd', 'HxV1cb', 'J4pQme',
  'Ldk8Yt', 'NvB3wr', 'Pq9Zas', 'Rtu5nk', 'Sxc0fj', 'Vbn6hl',
] as const;

export function makeTape(now: number, count: number): TapeRow[] {
  const rand = mulberry32(0x5eed10);
  const rows: TapeRow[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(makeTapeRow(now - i * 1_450 - Math.floor(rand() * 900), rand, `seed-${i}`));
  }
  return rows;
}

export function makeTapeRow(ts: number, rand: () => number, id: string): TapeRow {
  const tok = TAPE_TOKENS[Math.floor(rand() * TAPE_TOKENS.length)] ?? TAPE_TOKENS[0];
  const trader = TRADERS[Math.floor(rand() * TRADERS.length)] ?? TRADERS[0];
  const whale = rand() > 0.93;
  const sol = whale ? 4 + rand() * 26 : 0.02 + rand() * 2.4;
  return {
    id,
    ts,
    mint: tok.mint,
    symbol: tok.symbol,
    isBuy: rand() > 0.44,
    solAmount: Number(sol.toFixed(4)),
    trader: `${trader}…${Math.floor(rand() * 9000 + 1000)}`,
    priceSol: Number((0.0000004 + rand() * 0.0000021).toFixed(9)),
  };
}

export const TOKEN_SIGNALS: readonly TokenSignalView[] = [
  {
    mint: MINTS.MOTH,
    symbol: 'MOTH',
    name: 'Mothlight',
    trades: 412,
    buys: 291,
    sells: 121,
    netSolFlow: 68.4,
    volumeSol: 214.8,
    uniqueBuyers: 3,
    uniqueSellers: 41,
    buyPressurePct: 70.63,
    volumeWeightedBuyPressurePct: 88.2,
    largestTradeSol: 41.2,
    priceChangePct: 214.8,
    rugHeat: {
      score: 78,
      reasons: [
        'only 3 unique buyer(s) against 41 sellers',
        'volume-weighted buy pressure 88.2% — one desk is the book',
        'largest single trade is 19.2% of window volume',
      ],
    },
    watched: false,
  },
  {
    mint: MINTS.GRIN,
    symbol: 'GRIN',
    name: 'Grinner',
    trades: 188,
    buys: 84,
    sells: 104,
    netSolFlow: -12.6,
    volumeSol: 96.2,
    uniqueBuyers: 47,
    uniqueSellers: 52,
    buyPressurePct: 44.68,
    volumeWeightedBuyPressurePct: 41.1,
    largestTradeSol: 6.8,
    priceChangePct: -18.4,
    rugHeat: { score: 34, reasons: ['sell-weighted flow over the window', 'thinning SOL volume vs the prior window'] },
    watched: false,
  },
  {
    mint: MINTS.LUMEN,
    symbol: 'LUMEN',
    name: 'Lumen',
    trades: 96,
    buys: 61,
    sells: 35,
    netSolFlow: 21.9,
    volumeSol: 61.4,
    uniqueBuyers: 38,
    uniqueSellers: 22,
    buyPressurePct: 63.54,
    volumeWeightedBuyPressurePct: 66.8,
    largestTradeSol: 4.1,
    priceChangePct: 42.6,
    rugHeat: { score: 18, reasons: ['broad buyer set', 'no single trade above 7% of window volume'] },
    watched: true,
  },
  {
    mint: MINTS.WIF,
    symbol: 'WIF',
    name: 'dogwifhat',
    trades: 1_204,
    buys: 640,
    sells: 564,
    netSolFlow: 44.2,
    volumeSol: 1_882.6,
    uniqueBuyers: 412,
    uniqueSellers: 388,
    buyPressurePct: 53.16,
    volumeWeightedBuyPressurePct: 51.2,
    largestTradeSol: 62.4,
    priceChangePct: 3.1,
    rugHeat: { score: 8, reasons: ['deep two-sided book', 'no concentration tells'] },
    watched: true,
  },
  {
    mint: MINTS.BONK,
    symbol: 'BONK',
    name: 'Bonk',
    trades: 2_841,
    buys: 1_402,
    sells: 1_439,
    netSolFlow: -9.8,
    volumeSol: 3_204.1,
    uniqueBuyers: 904,
    uniqueSellers: 921,
    buyPressurePct: 49.35,
    volumeWeightedBuyPressurePct: 49.8,
    largestTradeSol: 88.2,
    priceChangePct: -1.4,
    rugHeat: { score: 6, reasons: ['deep two-sided book', 'no concentration tells'] },
    watched: true,
  },
  {
    mint: '2QsYtNfEd8HwUj3TgMv6BxKcQ1WpCk9zLmA4vXbRppump',
    symbol: 'VELLUM',
    name: 'Vellum',
    trades: 0,
    buys: 0,
    sells: 0,
    netSolFlow: 0,
    volumeSol: 0,
    uniqueBuyers: 0,
    uniqueSellers: 0,
    buyPressurePct: 0,
    volumeWeightedBuyPressurePct: 0,
    largestTradeSol: 0,
    priceChangePct: null,
    rugHeat: { score: 60, reasons: ['no trades in window — illiquid / inactive'] },
    watched: false,
  },
];
