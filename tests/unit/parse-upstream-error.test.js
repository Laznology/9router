import { describe, it, expect } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

describe("parseUpstreamError", () => {
  it("returns the raw upstream body for Request Details", async () => {
    const body = JSON.stringify({ error: { message: "Model is unavailable" } });
    const response = new Response(body, {
      status: 400,
      headers: { "content-type": "application/json" },
    });

    await expect(parseUpstreamError(response)).resolves.toMatchObject({
      statusCode: 400,
      message: "Model is unavailable",
      rawBody: body,
    });
  });

  it("keeps a non-JSON error body intact", async () => {
    const body = "upstream exploded";
    const response = new Response(body, { status: 502 });

    await expect(parseUpstreamError(response)).resolves.toMatchObject({
      statusCode: 502,
      message: body,
      rawBody: body,
    });
  });
});
