import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TradingOrchestrator } from "./index.js";
type Principal = { subject: string; scopes: string[]; authenticated?: boolean };
export function registerTradingApi(
  app: FastifyInstance,
  c: {
    trading: Pick<
      TradingOrchestrator,
      | "quote"
      | "execute"
      | "status"
      | "approve"
      | "refreshApproval"
      | "submit"
      | "recoverAndReconcile"
    >;
    principal: (q: FastifyRequest) => Principal;
  },
) {
  const denied = (q: FastifyRequest, r: any, scope: string) => {
      const principal = c.principal(q);
      if (principal.authenticated === false) {
        r.code(401).send({
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        });
        return true;
      }
      if (!principal.scopes.includes(scope)) {
        r.code(403).send({
          error: { code: "FORBIDDEN", message: `Missing ${scope}` },
        });
        return true;
      }
      return false;
    },
    key = (q: any, r: any) => {
      const k = String(q.headers["idempotency-key"] ?? "");
      if (!k) r.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      return k;
    };
  app.post("/v1/trading/quote", async (q: any, r) => {
    if (denied(q, r, "trading:quote")) return;
    const b = q.body ?? {};
    try {
      return await c.trading.quote({ ...b, amountIn: BigInt(b.amountIn) });
    } catch (e) {
      return r.code(400).send({
        error: {
          code: "INVALID_INTENT",
          message: e instanceof Error ? e.message : "invalid",
        },
      });
    }
  });
  app.post("/v1/trading/execute", async (q: any, r) => {
    if (denied(q, r, "trading:execute")) return;
    const k = key(q, r);
    if (!k) return;
    try {
      return r.code(202).send(
        await c.trading.execute(q.body.quoteId, {
          idempotencyKey: k,
          actor: c.principal(q).subject,
          dryRun: q.body.dryRun ?? true,
        }),
      );
    } catch (e) {
      return r.code(409).send({
        error: {
          code: "EXECUTION_REJECTED",
          message: e instanceof Error ? e.message : "rejected",
        },
      });
    }
  });
  app.post("/v1/trading/executions/:id/approve", async (q: any, r) => {
    if (denied(q, r, "trading:approve")) return;
    if (!key(q, r)) return;
    try {
      const b = q.body ?? {};
      c.trading.approve(q.params.id, c.principal(q).subject, {
        decision: b.decision,
        challenge: b.challenge,
        nonce: b.nonce,
        expectedRevision: b.expectedRevision,
        timestamp: b.timestamp,
        proof: b.proof,
        reason: b.reason,
      });
      return r.code(202).send(c.trading.refreshApproval(q.params.id));
    } catch (e) {
      return r.code(409).send({
        error: {
          code: "APPROVAL_REJECTED",
          message: e instanceof Error ? e.message : "rejected",
        },
      });
    }
  });
  app.post("/v1/trading/executions/:id/submit", async (q: any, r) => {
    if (denied(q, r, "trading:execute")) return;
    if (!key(q, r)) return;
    try {
      return r.code(202).send(await c.trading.submit(q.params.id));
    } catch (e) {
      return r.code(409).send({
        error: {
          code: "SUBMIT_REJECTED",
          message: e instanceof Error ? e.message : "rejected",
        },
      });
    }
  });
  app.post("/v1/trading/reconcile", async (q: any, r) => {
    if (denied(q, r, "trading:reconcile")) return;
    return r.code(202).send(await c.trading.recoverAndReconcile());
  });
  app.get("/v1/trading/executions/:id", async (q: any, r) => {
    if (denied(q, r, "trading:quote")) return;
    try {
      return c.trading.status(q.params.id);
    } catch {
      return r.code(404).send({ error: { code: "NOT_FOUND" } });
    }
  });
  return app;
}
