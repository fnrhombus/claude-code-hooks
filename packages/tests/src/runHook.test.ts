import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  addContext,
  allow,
  type HookHandlers,
  HookBlock,
  runHook,
  updateInput,
} from "@fnrhombus/claude-code-hooks";

function stdinOf(obj: unknown): NodeJS.ReadableStream {
  return Readable.from([JSON.stringify(obj)]);
}

function captureWritable(): NodeJS.WritableStream & { data: string } {
  const chunks: string[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  }) as unknown as NodeJS.WritableStream & { data: string };
  Object.defineProperty(w, "data", {
    get: () => chunks.join(""),
  });
  return w;
}

function captureExit(): { code: number | null; exit: (code: number) => never } {
  const state: { code: number | null } = { code: null };
  return {
    get code() {
      return state.code;
    },
    exit: (code: number) => {
      state.code = code;
      // Throw to short-circuit execution the way process.exit would.
      throw new Error(`__exit:${code}`);
    },
  } as unknown as { code: number | null; exit: (code: number) => never };
}

async function runWith(
  handlers: Parameters<typeof runHook>[0],
  input: unknown,
) {
  const stdout = captureWritable();
  const stderr = captureWritable();
  const exitState = captureExit();
  try {
    await runHook(handlers, {
      stdin: stdinOf(input),
      stdout,
      stderr,
      exit: exitState.exit,
    });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("__exit:")) {
      throw err;
    }
  }
  return { stdout: stdout.data, stderr: stderr.data, code: exitState.code };
}

describe("runHook", () => {
  it("writes handler output as JSON to stdout and exits 0", async () => {
    const { stdout, stderr, code } = await runWith(
      { preToolUse: () => allow() },
      {
        session_id: "s",
        transcript_path: "/t",
        cwd: "/c",
        hook_event_name: "PreToolUse",
        permission_mode: "default",
        tool_use_id: "tu",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it("writes nothing to stdout when handler returns void", async () => {
    const { stdout, code } = await runWith(
      { sessionStart: () => undefined },
      {
        session_id: "s",
        transcript_path: "/t",
        cwd: "/c",
        hook_event_name: "SessionStart",
        source: "startup",
        model: "x",
      },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 2 with reason on stderr when handler throws HookBlock", async () => {
    const { stdout, stderr, code } = await runWith(
      {
        preToolUse: () => {
          throw new HookBlock("dangerous");
        },
      },
      {
        session_id: "s",
        transcript_path: "/t",
        cwd: "/c",
        hook_event_name: "PreToolUse",
        permission_mode: "default",
        tool_use_id: "tu",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      },
    );

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("dangerous");
  });

  it("exits 1 when handler throws a non-HookBlock error", async () => {
    const { stderr, code } = await runWith(
      {
        preToolUse: () => {
          throw new Error("oops");
        },
      },
      {
        session_id: "s",
        transcript_path: "/t",
        cwd: "/c",
        hook_event_name: "PreToolUse",
        permission_mode: "default",
        tool_use_id: "tu",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("handler threw");
    expect(stderr).toContain("oops");
  });

  it("exits 1 on malformed stdin JSON", async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const state = { code: null as number | null };
    try {
      await runHook(
        {},
        {
          stdin: Readable.from(["not json at all"]),
          stdout,
          stderr,
          exit: ((code: number) => {
            state.code = code;
            throw new Error(`__exit:${code}`);
          }) as (code: number) => never,
        },
      );
    } catch {}
    expect(state.code).toBe(1);
    expect(stderr.data).toContain("failed to parse stdin");
  });

  it("combines addContext with universal fields end-to-end", async () => {
    const { stdout } = await runWith(
      {
        sessionStart: () => ({
          ...addContext("hello"),
          systemMessage: "warn",
        }),
      },
      {
        session_id: "s",
        transcript_path: "/t",
        cwd: "/c",
        hook_event_name: "SessionStart",
        source: "startup",
        model: "x",
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      systemMessage: "warn",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "hello",
      },
    });
  });

  it("updateInput round-trips through stdin → handler → stdout", async () => {
    const handlers: HookHandlers = {
      preToolUse: (input) => {
        if (input.tool_name !== "Bash") return allow();
        const cmd = (input.tool_input as { command: string }).command;
        return updateInput({ command: cmd + " --verbose" });
      },
    };
    const { stdout } = await runWith(handlers, {
        session_id: "s",
        transcript_path: "/t",
        cwd: "/c",
        hook_event_name: "PreToolUse",
        permission_mode: "default",
        tool_use_id: "tu",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "ls --verbose" },
      },
    });
  });
});
