const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Service-only OCR diagnostics. This endpoint never reads or changes bookings. */
export function opticalCheckHandler(
  deps: {
    serviceKey: string;
    serviceKeyHash?: string;
    visionKey: string;
    fetcher?: typeof fetch;
  },
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const token = (req.headers.get("authorization") || "").replace(
      /^Bearer /i,
      "",
    );
    if (!deps.serviceKey || !token) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const digest = async (s: string) =>
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
      );
    const [actual, expected] = await Promise.all([
      digest(token),
      digest(deps.serviceKey),
    ]);
    let difference = 0;
    for (let i = 0; i < actual.length; i++) {
      difference |= actual[i] ^ expected[i];
    }
    const configuredHash = deps.serviceKeyHash || "";
    let hashDifference = 1;
    if (/^[a-f0-9]{64}$/.test(configuredHash)) {
      hashDifference = 0;
      for (let i = 0; i < actual.length; i++) {
        hashDifference |= actual[i] ^
          parseInt(configuredHash.slice(i * 2, i * 2 + 2), 16);
      }
    }
    if (difference && hashDifference) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!deps.visionKey) {
      return Response.json({ error: "OCR is not configured" }, { status: 503 });
    }
    try {
      const reader = req.body?.getReader();
      if (!reader) {
        return Response.json({ error: "Image required" }, { status: 400 });
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return Response.json({ error: "Image too large" }, { status: 413 });
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof body.imageBase64 !== "string" || !body.imageBase64.length ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64) ||
        body.imageBase64.length % 4 !== 0
      ) return Response.json({ error: "Invalid image" }, { status: 400 });
      const feature = body.feature || "DOCUMENT_TEXT_DETECTION";
      if (!["TEXT_DETECTION", "DOCUMENT_TEXT_DETECTION"].includes(feature)) {
        return Response.json({ error: "Invalid OCR feature" }, { status: 400 });
      }
      const response = await (deps.fetcher || fetch)(
        "https://vision.googleapis.com/v1/images:annotate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": deps.visionKey,
          },
          body: JSON.stringify({
            requests: [{
              image: { content: body.imageBase64 },
              features: [{ type: feature }],
              imageContext: {
                textDetectionParams: {
                  enableTextDetectionConfidenceScore: true,
                },
              },
            }],
          }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok) {
        return Response.json({ error: "OCR provider unavailable" }, {
          status: 502,
        });
      }
      return Response.json(await response.json(), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return Response.json({
        error: error instanceof SyntaxError
          ? "Invalid request"
          : "OCR request failed",
      }, { status: error instanceof SyntaxError ? 400 : 502 });
    }
  };
}
