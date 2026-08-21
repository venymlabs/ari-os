/**
 * "What is this?" — a numbered one-pager, shown once per visitor and reachable
 * forever from the system strip. Deliberately a printed sheet, not a product
 * tour: bone stock, ink rules, a numbered list you can read in twenty seconds.
 */

import { useEffect } from 'react';
import { IconClose } from '../lib/icons';

const SEEN_KEY = 'ari-os.web.intro.v1';

export function hasSeenIntro(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode — showing it again is harmless */
  }
}

const POINTS: readonly (readonly [string, string])[] = [
  [
    'The model only ever writes an intent',
    'The LLM has read tools and proposal tools. It has no wallet, no calldata, no signing endpoint. The most it can produce is a structured TradeIntent — plain, journalable data.',
  ],
  [
    'One chokepoint decides',
    'Every value-moving action passes through TradeGateway.execute(). It re-reads policy from the kernel — never from the prompt — and re-validates the intent from scratch. Nothing it checks is sourced from model output.',
  ],
  [
    'Caps are denominated in what leaves your wallet',
    'Spend limits are in SOL or USDC base units on the input leg. No price oracle sits in the safety path, so a brand-new memecoin with a broken price cannot talk its way past a cap.',
  ],
  [
    'A human binds the transaction',
    'The Approvals screen is the boundary made visible: the model’s ask on the left, the kernel’s verdict on the right. Approving binds one operator to one exact set of transaction bytes — not to an idea of a trade.',
  ],
  [
    'A failed guard is not a warning',
    'If any guard fails, approval is impossible rather than discouraged. The kill switch re-fails every pending intent the instant you engage it. Fail closed, always.',
  ],
  [
    'Expiry is terminal',
    'The kernel persists the signed transaction before broadcast and a reconciler owns its lifecycle. If a blockhash dies, that intent is dead — it is never re-signed under a new one. That is how you avoid double-spending.',
  ],
];

export function Intro({ onClose }: { readonly onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="intro" role="dialog" aria-modal="true" aria-label="What is this?">
      <div className="intro-sheet">
        <div className="intro-top">
          <span className="mono">ari os / control · orientation sheet · 01 of 01</span>
          <button type="button" className="intro-close" onClick={onClose} aria-label="Close">
            <IconClose size={13} />
          </button>
        </div>

        <div className="intro-body">
          <span className="mono" style={{ color: 'rgba(5,7,6,.55)' }}>
            what is this
          </span>
          <h2>
            The model proposes.
            <br />
            The kernel <em>disposes.</em>
          </h2>
          <p className="intro-lede">
            This is the operator console for a self-hosted, non-custodial Solana trading agent. The
            agent runs on your machine, holds your keys, and cannot move a lamport without passing
            the six checks below.
          </p>

          <ol className="intro-list">
            {POINTS.map(([title, body], i) => (
              <li key={title}>
                <b>{String(i + 1).padStart(2, '0')}</b>
                <div>
                  <strong>{title}</strong>
                  <span>{body}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="intro-foot">
          <span className="mono" style={{ color: 'rgba(5,7,6,.6)' }}>
            reopen any time from “what is this?” in the system strip
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Enter the console
          </button>
        </div>
      </div>
    </div>
  );
}
