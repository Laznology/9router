// Conversation-bearing fields in a stored request detail. Metadata (model,
// tokens, latency, status) is always safe to return; these fields can contain
// prompts, tool output, and provider responses.
export const REQUEST_DETAIL_PAYLOAD_KEYS = [
  "request",
  "providerRequest",
  "providerResponse",
  "response",
];

export function redactRequestDetails(details) {
  return (details || []).map((detail) => {
    const redacted = { ...detail };
    for (const key of REQUEST_DETAIL_PAYLOAD_KEYS) {
      if (redacted[key] !== undefined) {
        redacted[key] = { redacted: true };
      }
    }
    return redacted;
  });
}
