/**
 * Authentication for the operator console.
 *
 * ─── the shape of the problem ───────────────────────────────────────────────
 *
 * The dashboard is a static bundle this daemon serves from its own origin. It
 * has no login screen and no token store: `web/src/data/http-source.ts` calls
 * `fetch(..., { credentials: 'same-origin' })` and
 * `new EventSource(url, { withCredentials: true })`. Both send COOKIES and
 * neither can attach an `Authorization` header. So the console authenticates
 * with a **same-origin session cookie**, minted by exchanging the daemon's
 * existing API bearer token exactly once at `POST /api/session`.
 *
 * Nothing about the existing bearer scheme changes: `API_BEARER_TOKEN` /
 * `API_BEARER_TOKEN_SHA256` remains the only credential, `API_SCOPES` remains
 * the only authority, and every API route also accepts a plain
 * `Authorization: Bearer` header so curl and the CLI work unchanged.
 *
 * ─── fail-closed ────────────────────────────────────────────────────────────
 *
 * With no bearer token configured, {@link ControlAuth.configured} is false, no
 * session can ever be minted, and EVERY control-plane route — the approvals
 * decision endpoint above all — answers 401 `AUTH_NOT_CONFIGURED`. There is no
 * "development mode" that opens it, and no way to reach the money path from a
 * browser that has not presented the operator's token.
 *
 * ─── CSRF ───────────────────────────────────────────────────────────────────
 *
 * Cookie auth means cross-site requests would otherwise ride along. Three
 * independent barriers, any one of which is sufficient:
 *
 *   1. `SameSite=Strict` — the browser will not attach the cookie to a request
 *      initiated by another site at all.
 *   2. Mutating routes require `content-type: application/json`, which a plain
 *      cross-origin HTML form cannot send without a CORS preflight.
 *   3. `Origin` / `Sec-Fetch-Site`, when present, must be same-origin.
 *
 * `@fastify/cors` is deliberately NOT registered on this surface, so no
 * cross-origin preflight can ever succeed either.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "ari_session";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;

export interface ControlAuthOptions {
  readonly bearerToken?: string | undefined;
  readonly bearerTokenSha256?: string | undefined;
  readonly scopes: readonly string[];
  readonly sessionTtlMs?: number;
  /** Force the `Secure` cookie attribute even for plaintext requests. */
  readonly secureCookies?: boolean;
  readonly now?: () => number;
}

export type ControlIdentity = {
  readonly via: "session" | "bearer";
  readonly scopes: readonly string[];
};

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class ControlAuth {
  readonly #expected: Buffer | undefined;
  readonly #scopes: readonly string[];
  readonly #ttl: number;
  readonly #secure: boolean;
  readonly #now: () => number;
  readonly #sessions = new Map<string, number>();

  constructor(options: ControlAuthOptions) {
    const hex = options.bearerTokenSha256;
    this.#expected = hex
      ? Buffer.from(hex.toLowerCase(), "hex")
      : options.bearerToken
        ? sha256(options.bearerToken)
        : undefined;
    this.#scopes = [...options.scopes];
    this.#ttl = options.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.#secure = options.secureCookies ?? false;
    this.#now = options.now ?? Date.now;
  }

  /** False when no credential is configured — every route then refuses. */
  get configured(): boolean {
    return this.#expected !== undefined;
  }

  get scopes(): readonly string[] {
    return this.#scopes;
  }

  hasScope(scope: string): boolean {
    return this.#scopes.includes(scope) || this.#scopes.includes("agent:admin");
  }

  /** Constant-time check of a raw bearer token against the configured one. */
  verifyToken(token: string): boolean {
    if (!this.#expected || !token) return false;
    const presented = sha256(token);
    return (
      presented.length === this.#expected.length &&
      timingSafeEqual(presented, this.#expected)
    );
  }

  verifyAuthorizationHeader(header: string | undefined): boolean {
    if (!header || !header.startsWith("Bearer ")) return false;
    return this.verifyToken(header.slice("Bearer ".length).trim());
  }

  /** Mint a session. Callers MUST have verified the bearer token first. */
  createSession(): { id: string; expiresAt: number } {
    this.#prune();
    if (this.#sessions.size >= MAX_SESSIONS) {
      // Oldest-expiring first; a console that is left open on twenty machines
      // should not be able to grow this map without bound.
      const oldest = [...this.#sessions.entries()].sort(
        (a, b) => a[1] - b[1],
      )[0];
      if (oldest) this.#sessions.delete(oldest[0]);
    }
    const id = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#ttl;
    this.#sessions.set(sha256(id).toString("hex"), expiresAt);
    return { id, expiresAt };
  }

  verifySession(id: string | undefined): boolean {
    if (!id) return false;
    const key = sha256(id).toString("hex");
    const expiresAt = this.#sessions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.#now()) {
      this.#sessions.delete(key);
      return false;
    }
    return true;
  }

  revokeSession(id: string | undefined): void {
    if (id) this.#sessions.delete(sha256(id).toString("hex"));
  }

  cookie(id: string, secure: boolean): string {
    const attrs = [
      `${SESSION_COOKIE}=${id}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(this.#ttl / 1000)}`,
    ];
    if (secure || this.#secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  clearedCookie(secure: boolean): string {
    const attrs = [
      `${SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
    ];
    if (secure || this.#secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, expiresAt] of this.#sessions)
      if (expiresAt <= now) this.#sessions.delete(key);
  }
}

/** Minimal RFC 6265 cookie-header parse — avoids a plugin for one cookie. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * True when a request either did not come from a browser page context, or came
 * from this very origin. Used only as CSRF depth — `SameSite=Strict` is the
 * primary control.
 */
export function isSameOrigin(headers: {
  origin?: string | undefined;
  host?: string | undefined;
  secFetchSite?: string | undefined;
}): boolean {
  const site = headers.secFetchSite;
  if (site && site !== "same-origin" && site !== "none") return false;
  if (!headers.origin) return true;
  try {
    return new URL(headers.origin).host === headers.host;
  } catch {
    return false;
  }
}
