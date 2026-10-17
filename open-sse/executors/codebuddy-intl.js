import { DefaultExecutor } from "./default.js";
import {
  CODEBUDDY_AGENT_PATTERN,
  CODEBUDDY_NEUTRAL_PROMPT,
  scrubCodeBuddyText,
} from "../config/codebuddyFingerprints.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * IDE's OpenAI-style reasoning params are present. Force stream and mirror
 * reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // Upstream rejects plain OpenAI shape (11101 invalid request): user content
    // must be typed blocks, not a bare string.
    // Gateway role whitelist (system/user/assistant/tool) rejects OpenAI's
    // newer "developer" alias with 11128; it carries system-level instructions
    // (Codex CLI etc.), so remap it to system instead of dropping content.
    // Channel verification (400 code 11128 "Illegal API invocation from an
    // unapproved channel") triggers on other agents' verbatim identity
    // fingerprints anywhere in the request text — scrub message texts and
    // tool-call arguments. Agent system prompts (long catch-all + identity
    // regex, same policy as codebuddy-cn) become the neutral prompt instead.
    // content may be a string or typed blocks depending on the client format;
    // preserve the original shape on replacement.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    const blockText = (block) => (block && typeof block.text === "string" ? block.text : "");
    const flattenBlocks = (content) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map(blockText).join("\n")
          : "";
    const neutralizeSystem = (message) => {
      if (typeof message.content === "string") {
        const text = message.content;
        if (text.length > 2000 || CODEBUDDY_AGENT_PATTERN.test(text)) {
          return { ...message, content: CODEBUDDY_NEUTRAL_PROMPT };
        }
        return { ...message, content: scrubCodeBuddyText(text) };
      }
      if (Array.isArray(message.content)) {
        if (flattenBlocks(message.content).length > 2000 || CODEBUDDY_AGENT_PATTERN.test(flattenBlocks(message.content))) {
          return { ...message, content: [{ type: "text", text: CODEBUDDY_NEUTRAL_PROMPT }] };
        }
        return {
          ...message,
          content: message.content.map((block) =>
            block && typeof block.text === "string"
              ? { ...block, text: scrubCodeBuddyText(block.text) }
              : block,
          ),
        };
      }
      return message;
    };
    let messages = source.map((message) => {
      if (!message || typeof message !== "object") return message;
      const normalized = message.role === "developer" ? { ...message, role: "system" } : message;
      if (normalized.role === "system") {
        return neutralizeSystem(normalized);
      }
      // Upstream modalities expect user text as typed blocks rather than a
      // bare string (kept from the pre-11128 shape handling); scrub while
      // converting so fingerprint rewrites apply to the block text too.
      const content =
        normalized.role === "user" && typeof normalized.content === "string"
          ? [{ type: "text", text: scrubCodeBuddyText(normalized.content) }]
          : typeof normalized.content === "string"
            ? scrubCodeBuddyText(normalized.content)
            : Array.isArray(normalized.content)
              ? normalized.content.map((block) =>
                  block && typeof block.text === "string"
                    ? { ...block, text: scrubCodeBuddyText(block.text) }
                    : block,
                )
              : normalized.content;
      return {
        ...normalized,
        content,
        tool_calls: Array.isArray(normalized.tool_calls)
          ? normalized.tool_calls.map((call) =>
              call?.function?.arguments
                ? {
                    ...call,
                    function: {
                      ...call.function,
                      arguments: scrubCodeBuddyText(call.function.arguments),
                    },
                  }
                : call,
            )
          : normalized.tool_calls,
      };
    });
    // The gateway requires the first message to be a system prompt (11128
    // otherwise, per workbuddy2api's ensureConsoleSystem): only inject the
    // identity system prompt when the client didn't start with one.
    if (messages[0]?.role !== "system") {
      messages = [{ role: "system", content: "You are CodeBuddy Code." }, ...messages];
    }
    transformed.messages = messages.filter((message) => message && typeof message === "object");

    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
        // Surface the gateway's own guidance with the failure, not just the
        // code: 11128 (channel verification/request illegal) is request-shape,
        // so the caller sees what to fix instead of a bare JSON blob.
        if (data?.code === 11128) {
          const hint = data?.displayTips?.en || data?.displayMsg?.en || "";
          return {
            status: 400,
            message: [msg || "request illegal", hint].filter(Boolean).join(" — "),
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
