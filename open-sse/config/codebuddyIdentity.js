/**
 * CodeBuddy channel headers — the gateway's channel verification requires the
 * official client's conversation/request header family (verified live
 * 2026-10-17: bare requests 400 code 11128 "request illegal"; adding the
 * family passes the channel check, later account-level checks aside).
 *
 * Evidence basis (upstream official CLI package @tencent-ai/codebuddy-code and
 * the 5.8.4 mitm captures recorded in workbuddy2api-hub's wb_identity.py):
 * - X-Conversation-ID: hyphenated UUIDv7 (client sends one per conversation;
 *   upstream keeps no per-session mapping, so a fresh id per request is safe)
 * - X-Conversation-Request-ID == X-Root-Request-ID: one value per user turn
 * - X-Conversation-Message-ID == X-Request-ID: fresh per request, 32-hex
 * - trace family: X-Trace-ID + traceparent + b3 (X-B3-*) with the same trace,
 *   fresh span, sampled
 * - X-Agent-Intent: "craft" (the model chat mode), X-Agent-Runtime: "local-agent"
 * - X-User-Id: the JWT `sub` claim when the credential is an OAuth token; not
 *   required by the channel check (probes passed without it) and absent for
 *   raw API-key credentials
 */
const UUID_BITS = 0xffffffffffffn;

/** 32-hex UUIDv7-with-hyphens shape (conversation id). */
export function conversationId() {
  return hexUuid().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

/** 32-hex no-hyphen UUIDv7 shape (request/message/trace ids). */
export function messageId() {
  return hexUuid();
}

function hexUuid() {
  const ms = BigInt(Date.now()) & UUID_BITS;
  const random = crypto.getRandomValues(new Uint8Array(10));
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(40 - 8 * i)) & 0xffn);
  bytes.set(random, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** OAuth tokens carry `sub`; plain API keys are not JWTs — null then. */
export function jwtSub(accessToken) {
  if (typeof accessToken !== "string" || !accessToken.includes(".")) return null;
  try {
    const payload = accessToken.split(".")[1].replace(/=+$/, "");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Per-request channel header family shared by both codebuddy executors. */
export function codeBuddyChannelHeaders(credentials) {
  const round = messageId();
  const message = messageId();
  const trace = messageId();
  const span = messageId().slice(0, 16);
  const headers = {
    "X-Conversation-ID": conversationId(),
    "X-Conversation-Request-ID": round,
    "X-Root-Request-ID": round,
    "X-Conversation-Message-ID": message,
    "X-Request-ID": message,
    "X-Agent-Intent": "craft",
    "X-Agent-Runtime": "local-agent",
    "X-Trace-ID": trace,
    "traceparent": `00-${trace}-${span}-01`,
    "b3": `${trace}-${span}-1`,
    "X-B3-TraceId": trace,
    "X-B3-SpanId": span,
    "X-B3-Sampled": "1",
  };
  const uid = jwtSub(credentials?.accessToken);
  if (uid) headers["X-User-Id"] = uid;
  return headers;
}
