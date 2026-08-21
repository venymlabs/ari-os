/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function newTradeId(): string {
  return newId("trd");
}

export function newReservationId(): string {
  return newId("rsv");
}

/**
 * A server-generated, high-entropy idempotency key.
 *
 * NEVER derive this from client-controllable input (a chat message id is
 * predictable; deriving from it lets an attacker pre-register a key to block or
 * replay a trade). This is the only sanctioned way to mint an idempotency key.
 */
export function newIdempotencyKey(): string {
  return `idem_${randomBytes(24).toString("base64url")}`;
}
