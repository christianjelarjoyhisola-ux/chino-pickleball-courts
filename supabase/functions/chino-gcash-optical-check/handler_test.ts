import { opticalCheckHandler } from "./handler.ts";
function assert(v: unknown) {
  if (!v) throw Error("Assertion failed");
}
Deno.test("configured existing service credential hash works without exposing the credential", async () => {
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("existing-service"),
      ),
    ),
  ).map((v) => v.toString(16).padStart(2, "0")).join("");
  const handler = opticalCheckHandler({
    serviceKey: "runtime-service",
    serviceKeyHash: hash,
    visionKey: "secret",
    fetcher: async () => Response.json({ responses: [] }),
  });
  const request = (token: string) =>
    new Request("https://test", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: '{"imageBase64":"YWJj"}',
    });
  assert((await handler(request("existing-service"))).status === 200);
  assert((await handler(request("wrong"))).status === 403);
});
Deno.test("OCR diagnostics reject public and owner tokens before calling provider", async () => {
  let calls = 0;
  const handler = opticalCheckHandler({
    serviceKey: "service",
    visionKey: "secret",
    fetcher: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const token of ["", "anon", "owner"]) {
    assert(
      (await handler(
        new Request("https://test", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          body: "{}",
        }),
      )).status === 403,
    );
  }
  assert(calls === 0);
});
Deno.test("service diagnostic preserves native annotations and never accepts invalid features", async () => {
  let calls = 0;
  const handler = opticalCheckHandler({
    serviceKey: "service",
    visionKey: "secret",
    fetcher: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert(body.requests[0].image.content === "YWJj");
      return Response.json({
        responses: [{ fullTextAnnotation: { text: "sample" } }],
      });
    },
  });
  const request = (body: unknown) =>
    new Request("https://test", {
      method: "POST",
      headers: { Authorization: "Bearer service" },
      body: JSON.stringify(body),
    });
  assert(
    (await handler(request({ imageBase64: "YWJj", feature: "FACE_DETECTION" })))
      .status === 400,
  );
  const result = await handler(request({ imageBase64: "YWJj" }));
  assert(result.status === 200);
  assert(
    (await result.json()).responses[0].fullTextAnnotation.text === "sample",
  );
  assert(calls === 1);
});
Deno.test("diagnostics bound payload and hide provider failures", async () => {
  const handler = opticalCheckHandler({
    serviceKey: "service",
    visionKey: "secret",
    fetcher: async () =>
      new Response("sensitive provider error", { status: 403 }),
  });
  const request = (body: string) =>
    new Request("https://test", {
      method: "POST",
      headers: { Authorization: "Bearer service" },
      body,
    });
  assert(
    (await handler(request("x".repeat(8 * 1024 * 1024 + 1)))).status === 413,
  );
  assert((await handler(request("{"))).status === 400);
  const result = await handler(request('{"imageBase64":"YWJj"}'));
  assert(result.status === 502);
  assert(!(await result.text()).includes("sensitive"));
});
