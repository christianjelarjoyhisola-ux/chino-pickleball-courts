import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AuditClient = {
  auth: {
    getUser(
      token: string,
    ): Promise<{ data: { user: { id: string } | null }; error?: unknown }>;
  };
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<
          {
            data: { id?: string; role?: string; status?: string } | null;
            error?: unknown;
          }
        >;
      };
    };
  };
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ error?: unknown }>;
};

type ActivityContext = {
  actorId: string;
  role: string;
  endpoint: string;
  requestId: string;
  action: string;
  targetType: string;
  targetId: string;
  startedLogged: boolean;
  client: AuditClient;
};

const contexts = new WeakMap<Request, ActivityContext>();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATOR_ROLES = new Set(["owner", "court_owner", "staff"]);

function identifier(value: unknown, fallback: string, max = 100): string {
  return typeof value === "string" && value.length <= max &&
      /^[a-zA-Z0-9_.:-]+$/.test(value)
    ? value
    : fallback;
}

function credentials() {
  return {
    url: Deno.env.get("SUPABASE_URL") || "",
    key: Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  };
}

class ActivityIdentityUnavailable extends Error {}

function rejectedCredential(error: unknown): boolean {
  const status = error && typeof error === "object"
    ? Number((error as { status?: unknown }).status)
    : 0;
  return status >= 400 && status < 500 && status !== 429;
}

/** Resolves a human operator only from validated Auth and canonical accounts. */
export async function verifiedAdminActivityActor(
  req: Request,
  db: AuditClient,
  serviceKey: string,
) {
  const token = (req.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
  if (!token || token === serviceKey) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error) {
      if (rejectedCredential(error)) return null;
      throw new ActivityIdentityUnavailable();
    }
    const id = data?.user?.id;
    if (!id || !UUID.test(id)) return null;
    const account = await db.from("accounts").select("id,role,status").eq(
      "id",
      id,
    ).maybeSingle();
    if (account.error) throw new ActivityIdentityUnavailable();
    if (
      account.data?.status !== "active" ||
      !OPERATOR_ROLES.has(account.data.role || "")
    ) return null;
    return { id, role: account.data.role! };
  } catch (error) {
    if (rejectedCredential(error)) return null;
    throw new ActivityIdentityUnavailable();
  }
}

/** Only a wrapper-verified actor may become a service-role attribution header. */
export function adminActivityClientOptions(
  req: Request,
  options: Record<string, any> = {},
): Record<string, any> & { global: { headers: Record<string, string> } } {
  const headers = new Headers(options.global?.headers || {});
  headers.delete("x-chino-audit-actor");
  headers.delete("x-chino-audit-request");
  const context = contexts.get(req);
  if (context) {
    headers.set("x-chino-audit-actor", context.actorId);
    headers.set("x-chino-audit-request", context.requestId);
  }
  return {
    ...options,
    global: {
      ...options.global,
      headers: Object.fromEntries(headers.entries()),
    },
  };
}

export function createAdminActivityClient(
  req: Request,
  url: string,
  key: string,
  options: Record<string, any> = {},
) {
  return createClient(url, key, adminActivityClientOptions(req, options));
}

/** Call only with identifiers already parsed/validated by the business handler. */
export function setAdminActivityContext(
  req: Request,
  values: { action?: string; targetType?: string; targetId?: string },
) {
  const context = contexts.get(req);
  if (!context) return;
  context.action = identifier(values.action, context.action, 80);
  context.targetType = identifier(values.targetType, context.targetType, 50);
  context.targetId = identifier(values.targetId, context.targetId, 120);
}

function unavailable() {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Activity history is temporarily unavailable. Please try again.",
      code: "AUDIT_UNAVAILABLE",
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/** Sensitive mixed-endpoint actions can require the durable attempt before work. */
export function requireAdminActivityAudit(req: Request): Response | null {
  const context = contexts.get(req);
  return context && !context.startedLogged ? unavailable() : null;
}

async function record(
  context: ActivityContext,
  outcome: string,
  status?: number,
): Promise<boolean> {
  try {
    const { error } = await context.client.rpc("record_admin_server_activity", {
      p_actor_id: context.actorId,
      p_event: "edge_request",
      p_target_type: context.targetType,
      p_target_id: context.targetId,
      p_outcome: outcome,
      p_details: {
        endpoint: context.endpoint,
        action: context.action,
        requestId: context.requestId,
        ...(status == null ? {} : { status }),
      },
    });
    return !error;
  } catch {
    return false;
  }
}

/** Outcomes describe the HTTP request, not a separate business/payment decision. */
export function withAdminActivity(
  endpoint: string,
  handler: (req: Request) => Response | Promise<Response>,
  options: {
    requireAudit?: boolean;
    environment?: () => { url: string; key: string };
    clientFactory?: (url: string, key: string) => AuditClient;
    warn?: (message: string) => void;
  } = {},
) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return handler(req);
    const { url, key } = (options.environment || credentials)();
    if (!url || !key) return handler(req);
    const db: AuditClient = options.clientFactory
      ? options.clientFactory(url, key)
      : createClient(url, key, {
        auth: { persistSession: false },
      }) as unknown as AuditClient;
    let actor;
    try {
      actor = await verifiedAdminActivityActor(req, db, key);
    } catch {
      // A transient lookup failure must not turn an operator into an anonymous
      // request that could perform unrecorded work after business auth retries.
      return unavailable();
    }
    if (!actor) return handler(req);
    const context: ActivityContext = {
      actorId: actor.id,
      role: actor.role,
      endpoint: identifier(endpoint, "admin-operation"),
      requestId: crypto.randomUUID(),
      action: req.method.toLowerCase(),
      targetType: "edge_function",
      targetId: identifier(endpoint, "admin-operation"),
      startedLogged: false,
      client: db,
    };
    contexts.set(req, context);
    context.startedLogged = await record(context, "attempted");
    if (!context.startedLogged && options.requireAudit) {
      contexts.delete(req);
      return unavailable();
    }
    try {
      const response = await handler(req);
      const outcome = response.status === 401 || response.status === 403
        ? "denied"
        : response.status >= 400
        ? "failed"
        : "success";
      if (!await record(context, outcome, response.status)) {
        (options.warn || console.warn)(
          "Admin activity result could not be persisted.",
        );
      }
      return response;
    } catch (error) {
      await record(context, "failed", 500);
      throw error;
    } finally {
      contexts.delete(req);
    }
  };
}
