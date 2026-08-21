import type { PolicyConfig } from "../kernel/contracts.js";

/**
 * The live handle on the kernel's `PolicyConfig`.
 *
 * `TradeGatewayImpl` takes `policy: () => PolicyConfig` and re-reads it at the
 * metal on every execute, so handing it {@link PolicyController.get} — rather
 * than a frozen object — is what makes the console's kill switch and dry-run
 * toggle real instead of decorative.
 *
 * Two invariants keep the console from being a privilege-escalation path:
 *
 *  1. **Boot-time opt-in is the ceiling.** `EXECUTION_MODE=live` requires a
 *     documented triple opt-in in `src/config/`. A browser session must never
 *     be able to reach past that, so `setExecutionEnabled(true)` is refused
 *     unless the process was booted live-enabled. Disarming is always allowed:
 *     the console can only ever *reduce* authority.
 *  2. **A policy nothing enforces cannot be toggled.** Until a
 *     {@link markEnforced} caller has wired this controller into a gateway,
 *     every mutation is refused. An operator pressing a kill switch that no
 *     money path reads would get false assurance, which is worse than an error.
 */
export class PolicyController {
  #policy: PolicyConfig;
  #enforced = false;
  readonly #canArm: boolean;

  constructor(initial: PolicyConfig, options: { canArm?: boolean } = {}) {
    this.#policy = initial;
    this.#canArm = options.canArm ?? initial.executionEnabled;
  }

  get(): PolicyConfig {
    return this.#policy;
  }

  /** True once a value-moving path re-reads this controller. */
  get enforced(): boolean {
    return this.#enforced;
  }

  /** True when the boot-time configuration permits arming execution at all. */
  get canArm(): boolean {
    return this.#canArm;
  }

  /** Called by the composition that wires this into a `TradeGateway`. */
  markEnforced(): void {
    this.#enforced = true;
  }

  setKillSwitch(engaged: boolean): PolicyConfig {
    // Engaging a stop is always safe; releasing one that nothing reads is not.
    if (!engaged) this.#requireEnforced("release the kill switch");
    this.#policy = { ...this.#policy, killSwitch: engaged };
    return this.#policy;
  }

  setExecutionEnabled(enabled: boolean): PolicyConfig {
    if (enabled) {
      this.#requireEnforced("arm execution");
      if (!this.#canArm)
        throw new PolicyControlError(
          "EXECUTION_NOT_PERMITTED",
          "this process was not booted with live execution enabled; arm it in the environment (EXECUTION_MODE) and restart",
        );
    }
    this.#policy = { ...this.#policy, executionEnabled: enabled };
    return this.#policy;
  }

  #requireEnforced(action: string): void {
    if (this.#enforced) return;
    throw new PolicyControlError(
      "POLICY_NOT_ENFORCED",
      `no money path is reading this policy, so it cannot ${action}; the kernel gateway is not composed (no wallet is mounted)`,
    );
  }
}

export type PolicyControlCode =
  "POLICY_NOT_ENFORCED" | "EXECUTION_NOT_PERMITTED";

export class PolicyControlError extends Error {
  readonly code: PolicyControlCode;
  constructor(code: PolicyControlCode, message: string) {
    super(message);
    this.name = "PolicyControlError";
    this.code = code;
  }
}

export function isPolicyControlError(e: unknown): e is PolicyControlError {
  return e instanceof PolicyControlError;
}
