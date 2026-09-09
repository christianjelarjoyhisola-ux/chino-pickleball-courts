import {
  adminActivityClientOptions,
  requireAdminActivityAudit,
  setAdminActivityContext,
  verifiedAdminActivityActor,
  withAdminActivity,
} from "./admin-activity.ts";

const ACTOR = "12345678-1234-4234-8234-123456789012";
const OTHER = "87654321-4321-4321-8321-210987654321";
const environment = () => ({
  url: "https://example.supabase.co",
  key: "service-secret",
});

function equal(actual: unknown, expected: unknown, label = "value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function mock(
  options: {
    role?: string;
    status?: string;
    authError?: boolean;
    authStatus?: number;
    authThrows?: boolean;
    accountError?: boolean;
    noAccount?: boolean;
    auditError?: boolean;
    actor?: string;
  } = {},
) {
  const calls: Record<string, any>[] = [];
  const tokens: string[] = [];
  const actor = options.actor || ACTOR;
  const db = {
    auth: {
      getUser: async (token: string) => {
        tokens.push(token);
        if (options.authThrows) throw new Error("network private detail");
        return {
          data: { user: options.authError ? null : { id: actor } },
          error: options.authError
            ? { status: options.authStatus ?? 401 }
            : null,
        };
      },
    },
    from: (table: string) => ({
      select: (_columns: string) => ({
        eq: (column: string, value: string) => ({
          maybeSingle: async () => {
            equal([table, column, value], ["accounts", "id", actor]);
            return {
              data: options.noAccount ? null : {
                id: actor,
                role: options.role || "court_owner",
                status: options.status || "active",
              },
              error: options.accountError
                ? { message: "database private detail" }
                : null,
            };
          },
        }),
      }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      equal(name, "record_admin_server_activity");
      calls.push(structuredClone(args));
      return {
        error: options.auditError
          ? "database unavailable with private detail"
          : null,
      };
    },
  };
  return {
    calls,
    tokens,
    db,
    clientFactory: () => db,
    environment,
    warn: (_message: string) => {},
  };
}

function request(
  token = "real-access-token",
  body =
    '{"password":"private-password","receipt":"private-receipt","actorId":"spoof"}',
) {
  return new Request(
    "https://example.supabase.co/functions/v1/manage-account",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-chino-audit-actor": OTHER,
        "x-chino-audit-request": OTHER,
        "content-type": "application/json",
      },
      body,
    },
  );
}

Deno.test("activity identity validates token and active canonical account, never caller actor headers", async () => {
  const state = mock();
  equal(
    await verifiedAdminActivityActor(request(), state.db, "service-secret"),
    { id: ACTOR, role: "court_owner" },
  );
  equal(state.tokens, ["real-access-token"]);
  for (
    const options of [{ authError: true }, { role: "host" }, {
      status: "suspended",
    }, { actor: "not-a-uuid" }]
  ) {
    const invalid = mock(options);
    equal(
      await verifiedAdminActivityActor(request(), invalid.db, "service-secret"),
      null,
    );
  }
  equal(
    await verifiedAdminActivityActor(
      request("service-secret"),
      state.db,
      "service-secret",
    ),
    null,
  );
  equal(
    await verifiedAdminActivityActor(
      new Request("https://example.test"),
      state.db,
      "service-secret",
    ),
    null,
  );
  equal(
    state.tokens.length,
    1,
    "service/public requests do not become operators",
  );
});

Deno.test("activity logs bounded metadata without consuming or exposing request body", async () => {
  const state = mock();
  const req = request();
  const handler = withAdminActivity("manage-account", (incoming) => {
    equal(incoming.bodyUsed, false);
    setAdminActivityContext(incoming, {
      action: "update",
      targetType: "account",
      targetId: OTHER,
    });
    return new Response("unchanged body", { status: 200 });
  }, { ...state, requireAudit: true });
  const result = await handler(req);
  equal(await result.text(), "unchanged body");
  equal(state.calls.length, 2);
  equal(state.calls.map((call) => call.p_outcome), ["attempted", "success"]);
  equal(state.calls[0].p_actor_id, ACTOR);
  equal(state.calls[1].p_target_id, OTHER);
  equal(state.calls[1].p_details.action, "update");
  equal(state.calls[0].p_details.requestId, state.calls[1].p_details.requestId);
  equal(Object.keys(state.calls[1].p_details).sort(), [
    "action",
    "endpoint",
    "requestId",
    "status",
  ]);
  equal(JSON.stringify(state.calls).includes("private-"), false);
  equal(req.bodyUsed, false);
});

Deno.test("only verified context supplies service attribution and preserves unrelated options", async () => {
  const state = mock();
  const req = request();
  const supplied = {
    auth: { persistSession: false },
    global: {
      headers: {
        "x-chino-audit-actor": OTHER,
        "x-chino-audit-request": OTHER,
        "x-other": "kept",
      },
    },
  };
  equal(adminActivityClientOptions(req, supplied).global.headers, {
    "x-other": "kept",
  });
  await withAdminActivity("manage-account", (incoming) => {
    const opts = adminActivityClientOptions(incoming, supplied);
    equal(opts.auth, { persistSession: false });
    equal(opts.global.headers["x-other"], "kept");
    equal(opts.global.headers["x-chino-audit-actor"], ACTOR);
    equal(
      opts.global.headers["x-chino-audit-request"],
      state.calls[0].p_details.requestId,
    );
    return new Response("ok");
  }, state)(req);
  equal(adminActivityClientOptions(req, supplied).global.headers, {
    "x-other": "kept",
  }, "context cleared after completion");
});

Deno.test("concurrent activity requests keep distinct actors and server correlation ids", async () => {
  const a = mock();
  const b = mock({ actor: OTHER });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const wrap = (state: ReturnType<typeof mock>, expected: string) =>
    withAdminActivity("review", async (req) => {
      if (++entered === 2) release();
      await barrier;
      equal(
        adminActivityClientOptions(req).global.headers["x-chino-audit-actor"],
        expected,
      );
      equal(
        adminActivityClientOptions(req).global.headers["x-chino-audit-request"],
        state.calls[0].p_details.requestId,
      );
      return new Response("ok");
    }, state);
  await Promise.all([
    wrap(a, ACTOR)(request()),
    wrap(b, OTHER)(request("second-token")),
  ]);
  equal(
    a.calls[0].p_details.requestId === b.calls[0].p_details.requestId,
    false,
  );
});

Deno.test("HTTP outcomes record denied and failed without logging response contents", async () => {
  for (
    const [status, outcome] of [
      [200, "success"],
      [400, "failed"],
      [401, "denied"],
      [403, "denied"],
      [500, "failed"],
    ] as const
  ) {
    const state = mock();
    const response = await withAdminActivity(
      "review",
      () => new Response("private-receipt", { status }),
      state,
    )(request());
    equal(response.status, status);
    equal(state.calls[1].p_outcome, outcome);
    equal(state.calls[1].p_details.status, status);
    equal(JSON.stringify(state.calls).includes("private-receipt"), false);
  }
});

Deno.test("sensitive mutation stops before handler when durable attempt fails", async () => {
  const state = mock({ auditError: true });
  let called = false;
  const response = await withAdminActivity("manage-account", () => {
    called = true;
    return new Response("ok");
  }, { ...state, requireAudit: true })(request());
  equal(response.status, 503);
  equal(called, false);
  equal((await response.json()).code, "AUDIT_UNAVAILABLE");
});

Deno.test("read-only request continues on audit outage; mixed mutation can fail closed", async () => {
  const state = mock({ auditError: true });
  const warnings: string[] = [];
  const opts = { ...state, warn: (value: string) => warnings.push(value) };
  const read = await withAdminActivity(
    "verify-gcash-receipt",
    () => new Response("signed link omitted from audit"),
    opts,
  )(request());
  equal(read.status, 200);
  equal(warnings, ["Admin activity result could not be persisted."]);
  const mutate = await withAdminActivity(
    "verify-gcash-receipt",
    (req) => requireAdminActivityAudit(req) || new Response("must not run"),
    opts,
  )(request());
  equal(mutate.status, 503);
});

Deno.test("public, system and preflight requests preserve existing handler behavior", async () => {
  const state = mock();
  for (
    const req of [
      new Request("https://example.test"),
      request("service-secret"),
      new Request("https://example.test", { method: "OPTIONS" }),
    ]
  ) {
    equal(
      (await withAdminActivity(
        "review",
        () => new Response("ok", { status: 202 }),
        state,
      )(req)).status,
      202,
    );
  }
  equal(state.calls.length, 0);
});

Deno.test("thrown business errors remain thrown and record only failed HTTP status", async () => {
  const state = mock();
  const error = new Error("private body in error");
  let caught;
  try {
    await withAdminActivity("review", () => {
      throw error;
    }, state)(request());
  } catch (value) {
    caught = value;
  }
  equal(caught === error, true);
  equal(state.calls[1].p_outcome, "failed");
  equal(state.calls[1].p_details.status, 500);
  equal(JSON.stringify(state.calls).includes("private"), false);
});

Deno.test("context rejects unsafe labels and targets", async () => {
  const state = mock();
  await withAdminActivity("review", (req) => {
    setAdminActivityContext(req, {
      action: "password=private value",
      targetType: "<script>",
      targetId: "signed?token=secret",
    });
    return new Response("ok");
  }, state)(request());
  equal(state.calls[1].p_details.action, "post");
  equal(state.calls[1].p_target_type, "edge_function");
  equal(state.calls[1].p_target_id, "review");
});

Deno.test("transient identity lookups fail closed without guessing an actor", async () => {
  for (
    const options of [
      { authError: true, authStatus: 503 },
      { authError: true, authStatus: 429 },
      { authThrows: true },
      { accountError: true },
    ]
  ) {
    const state = mock(options);
    let called = false;
    const req = request();
    const response = await withAdminActivity("manage-account", () => {
      called = true;
      return new Response("unsafe work");
    }, { ...state, requireAudit: true })(req);
    equal(response.status, 503);
    equal(called, false);
    equal(state.calls.length, 0);
    equal(req.bodyUsed, false);
    equal(adminActivityClientOptions(req).global.headers, {});
    equal((await response.text()).includes("private"), false);
  }
});

Deno.test("known invalid credentials and absent accounts retain business authentication", async () => {
  for (const options of [{ authError: true }, { noAccount: true }]) {
    const state = mock(options);
    let called = false;
    const response = await withAdminActivity("manage-account", () => {
      called = true;
      return new Response("existing auth refusal", { status: 401 });
    }, { ...state, requireAudit: true })(request());
    equal(response.status, 401);
    equal(called, true);
    equal(state.calls.length, 0);
  }
});
