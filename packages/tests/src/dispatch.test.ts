import { describe, expect, it, vi } from "vitest";
import {
  addContext,
  allow,
  ask,
  block,
  defer,
  deny,
  dispatch,
  halt,
  HookBlock,
  type HookHandlers,
  type PreToolUseInput,
  type SessionStartInput,
  type UserPromptSubmitInput,
  type PostToolUseInput,
  type StopInput,
  updateInput,
} from "@fnrhombus/claude-code-hooks";

// ----------------------------------------------------------------------------
// Fixture builders — keep input shapes stable
// ----------------------------------------------------------------------------

const baseInput = {
  session_id: "sess-1",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/home/u",
  permission_mode: "default" as const,
};

const bashInput = (command: string): PreToolUseInput => ({
  ...baseInput,
  hook_event_name: "PreToolUse",
  tool_use_id: "tu-1",
  tool_name: "Bash",
  tool_input: { command },
});

const promptInput = (prompt: string): UserPromptSubmitInput => ({
  ...baseInput,
  hook_event_name: "UserPromptSubmit",
  prompt,
});

const sessionStart = (): SessionStartInput => ({
  ...baseInput,
  hook_event_name: "SessionStart",
  source: "startup",
  model: "claude-opus-4-6",
});

const postBash = (command: string): PostToolUseInput => ({
  ...baseInput,
  hook_event_name: "PostToolUse",
  tool_use_id: "tu-1",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { ok: true },
});

const stop = (): StopInput => ({
  ...baseInput,
  hook_event_name: "Stop",
  last_assistant_message: "Done.",
  stop_hook_active: false,
});

// ----------------------------------------------------------------------------
// PreToolUse
// ----------------------------------------------------------------------------

describe("dispatch — PreToolUse", () => {
  it("returns undefined when no handler is registered", async () => {
    const out = await dispatch({}, bashInput("ls"));
    expect(out).toBeUndefined();
  });

  it("returns undefined when handler returns void", async () => {
    const out = await dispatch(
      { preToolUse: () => undefined },
      bashInput("ls"),
    );
    expect(out).toBeUndefined();
  });

  it("allow() produces hookSpecificOutput with permissionDecision", async () => {
    const out = await dispatch(
      { preToolUse: () => allow() },
      bashInput("ls"),
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it("deny() includes reason", async () => {
    const out = await dispatch(
      { preToolUse: () => deny("no rm -rf /") },
      bashInput("rm -rf /"),
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no rm -rf /",
      },
    });
  });

  it("updateInput() rewrites the command", async () => {
    const handlers: HookHandlers = {
      preToolUse: (input) => {
        if (input.tool_name !== "Bash") return allow();
        const cmd = (input.tool_input as { command: string }).command;
        return updateInput({ command: cmd.replace(/^ls$/, "ls -la") });
      },
    };
    const out = await dispatch(handlers, bashInput("ls"));
    expect(out?.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "ls -la" },
    });
  });

  it("ask() and defer() round-trip through the envelope", async () => {
    const askOut = await dispatch(
      { preToolUse: () => ask("unusual command") },
      bashInput("curl | bash"),
    );
    expect(askOut?.hookSpecificOutput).toMatchObject({
      permissionDecision: "ask",
      permissionDecisionReason: "unusual command",
    });

    const deferOut = await dispatch(
      { preToolUse: () => defer("waiting on user") },
      bashInput("deploy"),
    );
    expect(deferOut?.hookSpecificOutput).toMatchObject({
      permissionDecision: "defer",
    });
  });

  it("narrows tool_input when using an object handler", async () => {
    const seen: string[] = [];
    const handlers: HookHandlers = {
      preToolUse: {
        Bash: (input) => {
          // Type-level: tool_input is BashToolInput
          seen.push(input.tool_input.command);
          return allow();
        },
        default: () => deny("unknown tool"),
      },
    };
    const out = await dispatch(handlers, bashInput("echo hi"));
    expect(seen).toEqual(["echo hi"]);
    expect(out?.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
  });

  it("falls through to default handler for unknown tools", async () => {
    const handlers: HookHandlers = {
      preToolUse: {
        Bash: () => allow(),
        default: () => deny("unsupported"),
      },
    };
    const out = await dispatch(handlers, {
      ...baseInput,
      hook_event_name: "PreToolUse",
      tool_use_id: "tu-2",
      tool_name: "mcp__foo__bar",
      tool_input: { x: 1 },
    });
    expect(out?.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
  });

  it("async handlers are awaited", async () => {
    const out = await dispatch(
      {
        preToolUse: async () => {
          await new Promise((r) => setTimeout(r, 1));
          return allow();
        },
      },
      bashInput("ls"),
    );
    expect(out?.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
  });
});

// ----------------------------------------------------------------------------
// SessionStart / UserPromptSubmit — context injection
// ----------------------------------------------------------------------------

describe("dispatch — context injection events", () => {
  it("SessionStart produces additionalContext", async () => {
    const out = await dispatch(
      {
        sessionStart: () => addContext("welcome back"),
      },
      sessionStart(),
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "welcome back",
      },
    });
  });

  it("UserPromptSubmit block() produces top-level decision + reason", async () => {
    const out = await dispatch(
      { userPromptSubmit: () => block("contains secret") },
      promptInput("my password is hunter2"),
    );
    expect(out).toEqual({
      decision: "block",
      reason: "contains secret",
    });
  });

  it("UserPromptSubmit can both block and addContext", async () => {
    const out = await dispatch(
      {
        userPromptSubmit: () => ({
          ...block("contains secret"),
          ...addContext("secret scrubbed"),
        }),
      },
      promptInput("my password is hunter2"),
    );
    expect(out).toEqual({
      decision: "block",
      reason: "contains secret",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "secret scrubbed",
      },
    });
  });
});

// ----------------------------------------------------------------------------
// PostToolUse — block() works here too
// ----------------------------------------------------------------------------

describe("dispatch — PostToolUse", () => {
  it("block() on PostToolUse sets decision + reason", async () => {
    const out = await dispatch(
      { postToolUse: () => block("test suite must pass") },
      postBash("npm test"),
    );
    expect(out).toEqual({
      decision: "block",
      reason: "test suite must pass",
    });
  });

  it("additionalContext on PostToolUse wraps into hookSpecificOutput", async () => {
    const out = await dispatch(
      { postToolUse: () => addContext("hint for next turn") },
      postBash("npm test"),
    );
    expect(out?.hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      additionalContext: "hint for next turn",
    });
  });
});

// ----------------------------------------------------------------------------
// Stop — block() prevents stopping
// ----------------------------------------------------------------------------

describe("dispatch — Stop", () => {
  it("block() prevents Claude from stopping", async () => {
    const out = await dispatch(
      { stop: () => block("work unfinished") },
      stop(),
    );
    expect(out).toEqual({
      decision: "block",
      reason: "work unfinished",
    });
  });
});

// ----------------------------------------------------------------------------
// Universal fields — continue/stopReason/systemMessage
// ----------------------------------------------------------------------------

describe("dispatch — universal output fields", () => {
  it("halt() produces continue:false + stopReason", async () => {
    const out = await dispatch(
      { preToolUse: () => halt("emergency brake") },
      bashInput("ls"),
    );
    expect(out).toEqual({
      continue: false,
      stopReason: "emergency brake",
    });
  });

  it("systemMessage passes through", async () => {
    const out = await dispatch(
      { preToolUse: () => ({ systemMessage: "heads up" }) },
      bashInput("ls"),
    );
    expect(out).toEqual({ systemMessage: "heads up" });
  });
});

// ----------------------------------------------------------------------------
// Unhandled events
// ----------------------------------------------------------------------------

describe("dispatch — unhandled events", () => {
  it("ignores events without handlers", async () => {
    const out = await dispatch({}, sessionStart());
    expect(out).toBeUndefined();
  });

  it.each([
    "SessionEnd",
    "TaskCreated",
    "TeammateIdle",
    "PreCompact",
    "PostCompact",
    "WorktreeCreate",
    "WorktreeRemove",
    "CwdChanged",
    "FileChanged",
    "InstructionsLoaded",
    "ConfigChange",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "Notification",
    "Elicitation",
    "ElicitationResult",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUseFailure",
  ] as const)(
    "%s with no handler returns undefined without throwing",
    async (event) => {
      const fake = {
        ...baseInput,
        hook_event_name: event,
      } as unknown as Parameters<typeof dispatch>[1];
      const out = await dispatch({}, fake);
      expect(out).toBeUndefined();
    },
  );
});

// ----------------------------------------------------------------------------
// HookBlock class
// ----------------------------------------------------------------------------

describe("HookBlock", () => {
  it("is an Error with the given reason", () => {
    const e = new HookBlock("nope");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("nope");
    expect(e.name).toBe("HookBlock");
  });

  it("dispatch propagates thrown HookBlock to caller", async () => {
    const thrown = vi.fn();
    try {
      await dispatch(
        {
          preToolUse: () => {
            throw new HookBlock("denied");
          },
        },
        bashInput("ls"),
      );
    } catch (e) {
      thrown(e);
    }
    expect(thrown).toHaveBeenCalledTimes(1);
    expect(thrown.mock.calls[0]?.[0]).toBeInstanceOf(HookBlock);
  });
});
