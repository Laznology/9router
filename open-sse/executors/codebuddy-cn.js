import { DefaultExecutor } from "./default.js";
import {
  CODEBUDDY_AGENT_PATTERN,
  CODEBUDDY_NEUTRAL_PROMPT,
  scrubCodeBuddyText,
} from "../config/codebuddyFingerprints.js";

/**
 * CodeBuddyExecutor — talks to https://copilot.tencent.com/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here — 9router still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    // Tencent's channel/content filter flags agent identity patterns (long
    // agent prompts, cross-agent fingerprints — see config/codebuddyFingerprints.js)
    // and rejects the whole request (11101 content filter / 11128 channel
    // verification). Screen agent system prompts (length catch-all + identity
    // regex), neutralize measured fingerprints everywhere, and replace flagged
    // system prompts while leaving legitimate user system prompts untouched.
    // content may be a string or typed blocks ([{type:"text",text}]) depending
    // on the incoming client format.
    if (Array.isArray(transformed.messages)) {
      transformed.messages = transformed.messages.map((message) => {
        if (!message || typeof message !== "object") return message;
        if (message.role !== "system") {
          // Non-system texts: narrow measured-fingerprint scrub only — the
          // catch-all swap exists to protect instructions, not user content.
          if (typeof message.content === "string") {
            return { ...message, content: scrubCodeBuddyText(message.content) };
          }
          if (Array.isArray(message.content)) {
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
        }
        if (typeof message.content === "string") {
          const text = message.content;
          if (text.length > 2000 || CODEBUDDY_AGENT_PATTERN.test(text)) {
            return { ...message, content: CODEBUDDY_NEUTRAL_PROMPT };
          }
          return { ...message, content: scrubCodeBuddyText(text) };
        }
        if (Array.isArray(message.content)) {
          const text = message.content
            .map((block) => (block && typeof block.text === "string" ? block.text : ""))
            .join("\n");
          if (text.length > 2000 || CODEBUDDY_AGENT_PATTERN.test(text)) {
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
      });
    }

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).
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
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyExecutor;
