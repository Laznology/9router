// 11128 channel verification — the intl gateway rejects the request when
// another coding agent's identity fingerprint appears verbatim in the request
// text ("Illegal API invocation from an unapproved channel"). Triggers and
// rewrites verified by live A/B probes against www.codebuddy.ai (2026-10-17).
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { scrubCodeBuddyText } from "../../open-sse/config/codebuddyFingerprints.js";

const exec = new CodeBuddyIntlExecutor();
const cn = new CodeBuddyExecutor();

const encode = (out) => JSON.stringify(out);

describe("scrubCodeBuddyText — measured 11128 triggers", () => {
  it("keeps the Claude Code identity but drops the framework attribution phrase", () => {
    const out = scrubCodeBuddyText(
      "You are Claude Code, Anthropic's official CLI for Claude. Help with git.",
    );
    expect(out).toContain("official CLI tool for Claude");
    expect(out).not.toContain("official CLI for Claude");
    expect(out).toContain("You are Claude Code");
  });

  it("rewrites the Main branch PR wording", () => {
    const out = scrubCodeBuddyText("Main branch (you will usually use this for PRs): main");
    expect(out).toContain("Default branch (you will usually use this for PRs)");
  });

  it("strips billing-header values and rewords bare mentions", () => {
    expect(scrubCodeBuddyText("x-anthropic-billing-header: day=1; resume")).toBe("resume");
    expect(scrubCodeBuddyText("x-anthropic-billing-header")).toBe("x-anthropic-billing-hdr");
  });

  it("is case-insensitive and idempotent", () => {
    const once = scrubCodeBuddyText(
      "sisyphus-junior - focused executor from ohmyopencode",
    );
    expect(once).not.toMatch(/ohmyopencode/i);
    expect(scrubCodeBuddyText(once)).toBe(once);
    expect(scrubCodeBuddyText("clean text")).toBe("clean text");
  });
});

describe("CodeBuddyIntlExecutor channel shapes", () => {
  it("maps the developer role onto system instead of dropping its content", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "developer", content: "Always answer briefly." }, { role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(out.messages[0]).toEqual({ role: "system", content: "Always answer briefly." });
    expect(encode(out.messages)).not.toContain('"developer"');
  });

  it("keeps a client-provided leading system prompt", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "system", content: "Custom instructions here." }, { role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(out.messages[0].content).toBe("Custom instructions here.");
  });

  it("injects the identity system prompt only when the first message is not system", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(out.messages[0].content).toBe("You are CodeBuddy Code.");
    expect(out.messages[1].content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("neutrizes agent system prompts and strips fingerprints in any role", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "developer", content: "You are Claude Code, Anthropic's official CLI for Claude." },
          { role: "user", content: "check x-anthropic-billing-header: day=1; flows" },
          // first system stays system; the measured trigger gets rewritten
          { role: "system", content: "(branch) Main branch (you will usually use this for PRs): main" },
        ],
      },
      false,
      {},
    );
    const wire = encode(out.messages);
    // flagged agent system becomes the neutral prompt (same policy as CN)…
    expect(wire).toContain(
      "You are a helpful AI assistant that helps with software engineering tasks.",
    );
    // …while the user text keeps its meaning after billing-header stripping
    expect(wire).toContain("check flows");
    expect(wire).not.toContain("x-anthropic-billing-header:");
    // replayed PR wording is rewritten in place, not dropped
    expect(wire).toContain("Default branch (you will usually use this for PRs)");
  });

  it("replaces long agent system prompts with the neutral one (parity with CN)", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "system", content: "you are claude code, anthropic's official cli." + "x".repeat(2100) }] },
      false,
      {},
    );
    expect(out.messages[0].content).toBe(
      "You are a helpful AI assistant that helps with software engineering tasks.",
    );
  });

  it("keeps reasoning params opt-in (#2071)", () => {
    const out = exec.transformRequest("glm-5.2", { messages: [{ role: "user", content: "hi" }] }, false, {});
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.summary_state ?? out.reasoning_summary).toBeUndefined();
    const asked = exec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      false,
      {},
    );
    expect(asked.reasoning_summary).toBe("auto");
  });
});

describe("CodeBuddyExecutor (CN) fingerprint scrub", () => {
  it("still swaps agent system prompts for the neutral one", () => {
    const out = cn.transformRequest(
      "glm-5.2",
      { messages: [{ role: "system", content: "You are Cursor, the AI Code Editor." }, { role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(out.messages[0].content).toBe(
      "You are a helpful AI assistant that helps with software engineering tasks.",
    );
  });

  it("scrubs fingerprints in short clean system prompts instead of swapping them", () => {
    const out = cn.transformRequest(
      "glm-5.2",
      { messages: [{ role: "system", content: "review x-anthropic-billing-header: day=1; flows" }, { role: "user", content: "hi" }] },
      false,
      {},
    );
    expect(out.messages[0].content).toBe("review flows");
  });

  it("leaves clean non-system messages untouched", () => {
    const out = cn.transformRequest(
      "glm-5.2",
      { messages: [{ role: "user", content: "plain request" }] },
      false,
      {},
    );
    expect(out.messages[0].content).toBe("plain request");
  });
});
