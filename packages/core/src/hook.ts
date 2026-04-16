import type {
  BuiltinToolInputMap,
  BuiltinToolName,
  ConfigChangeInput,
  CwdChangedInput,
  ElicitationHookOutput,
  ElicitationInput,
  ElicitationResultHookOutput,
  ElicitationResultInput,
  FileChangedInput,
  HookInput,
  HookOutput,
  InstructionsLoadedInput,
  NotificationHookOutput,
  NotificationInput,
  PermissionDeniedHookOutput,
  PermissionDeniedInput,
  PermissionRequestHookOutput,
  PermissionRequestInput,
  PostCompactInput,
  PostToolUseFailureHookOutput,
  PostToolUseFailureInput,
  PostToolUseHookOutput,
  PostToolUseInput,
  PreCompactInput,
  PreToolUseHookOutput,
  PreToolUseInput,
  SessionEndInput,
  SessionStartHookOutput,
  SessionStartInput,
  StopFailureInput,
  StopInput,
  SubagentStartHookOutput,
  SubagentStartInput,
  SubagentStopInput,
  TaskCompletedInput,
  TaskCreatedInput,
  TeammateIdleInput,
  UserPromptSubmitHookOutput,
  UserPromptSubmitInput,
  WorktreeCreateHookOutput,
  WorktreeCreateInput,
  WorktreeRemoveInput,
} from "./types.js";

// ============================================================================
// Handler return shapes (one per event)
//
// Handlers return just the event-specific fields. The wrapper assembles the
// full HookOutput envelope — including the `hookSpecificOutput.hookEventName`
// discriminator — so handler code never has to.
// ============================================================================

/** Universal output fields — accepted on every handler's return value. */
export interface UniversalReturn {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
}

/** Derive a handler return type from a HookOutput type: drop the discriminator, add universal fields. */
type HookReturn<T> = Omit<T, "hookEventName"> & UniversalReturn;
type BlockableHookReturn<T> = HookReturn<T> & { block?: string };

export type PreToolUseReturn = HookReturn<PreToolUseHookOutput>;
export type PermissionRequestReturn = HookReturn<PermissionRequestHookOutput>;
export type PostToolUseReturn = BlockableHookReturn<PostToolUseHookOutput>;
export type PostToolUseFailureReturn = HookReturn<PostToolUseFailureHookOutput>;
export type PermissionDeniedReturn = HookReturn<PermissionDeniedHookOutput>;
export type UserPromptSubmitReturn = BlockableHookReturn<UserPromptSubmitHookOutput>;
export type SessionStartReturn = HookReturn<SessionStartHookOutput>;
export type SubagentStartReturn = HookReturn<SubagentStartHookOutput>;
export type NotificationReturn = HookReturn<NotificationHookOutput>;
export type WorktreeCreateReturn = HookReturn<WorktreeCreateHookOutput>;
export type ElicitationReturn = HookReturn<ElicitationHookOutput>;
export type ElicitationResultReturn = HookReturn<ElicitationResultHookOutput>;

/** Events that support `decision: "block"` but have no event-specific output fields. */
export type BlockableReturn = UniversalReturn & { block?: string };

/** A handler return is the event shape, `void`, or `undefined` (= no-op). */
export type MaybeReturn<T> = T | void | undefined;

// ============================================================================
// Handler signatures
// ============================================================================

export type Handler<Input, Return> = (
  input: Input,
) => MaybeReturn<Return> | Promise<MaybeReturn<Return>>;

/**
 * For PreToolUse / PostToolUse / PermissionRequest / PermissionDenied /
 * PostToolUseFailure, the handler can also be an object keyed by tool name
 * whose values are tool-narrowed handlers.
 */
export type ToolHandlerMap<BaseInput extends { tool_name: string }, Return> = {
  [K in BuiltinToolName]?: Handler<Narrow<BaseInput, BuiltinToolInputMap[K]>, Return>;
} & {
  /** Matches any tool not handled above, including MCP tools. */
  default?: Handler<BaseInput, Return>;
};

/** Utility: replace `tool_input` on BaseInput with a narrowed tool input type. */
type Narrow<BaseInput extends { tool_name: string }, TInput> =
  BaseInput extends { tool_name: string; tool_input: unknown }
    ? Omit<BaseInput, "tool_input"> & { tool_input: TInput }
    : BaseInput;

/** Handler or tool-keyed handler map for events that carry tool context. */
type ToolAwareHandler<I extends { tool_name: string }, R> =
  | Handler<I, R>
  | ToolHandlerMap<I, R>;

// ============================================================================
// runHook — dispatch object keyed by event
// ============================================================================

export interface HookHandlers {
  sessionStart?: Handler<SessionStartInput, SessionStartReturn>;
  sessionEnd?: Handler<SessionEndInput, UniversalReturn>;
  userPromptSubmit?: Handler<UserPromptSubmitInput, UserPromptSubmitReturn>;
  preToolUse?: ToolAwareHandler<PreToolUseInput, PreToolUseReturn>;
  permissionRequest?: ToolAwareHandler<PermissionRequestInput, PermissionRequestReturn>;
  permissionDenied?: ToolAwareHandler<PermissionDeniedInput, PermissionDeniedReturn>;
  postToolUse?: ToolAwareHandler<PostToolUseInput, PostToolUseReturn>;
  postToolUseFailure?: ToolAwareHandler<PostToolUseFailureInput, PostToolUseFailureReturn>;
  notification?: Handler<NotificationInput, NotificationReturn>;
  subagentStart?: Handler<SubagentStartInput, SubagentStartReturn>;
  subagentStop?: Handler<SubagentStopInput, BlockableReturn>;
  taskCreated?: Handler<TaskCreatedInput, UniversalReturn>;
  taskCompleted?: Handler<TaskCompletedInput, UniversalReturn>;
  stop?: Handler<StopInput, BlockableReturn>;
  stopFailure?: Handler<StopFailureInput, UniversalReturn>;
  teammateIdle?: Handler<TeammateIdleInput, UniversalReturn>;
  instructionsLoaded?: Handler<InstructionsLoadedInput, UniversalReturn>;
  configChange?: Handler<ConfigChangeInput, BlockableReturn>;
  cwdChanged?: Handler<CwdChangedInput, UniversalReturn>;
  fileChanged?: Handler<FileChangedInput, UniversalReturn>;
  worktreeCreate?: Handler<WorktreeCreateInput, WorktreeCreateReturn>;
  worktreeRemove?: Handler<WorktreeRemoveInput, UniversalReturn>;
  preCompact?: Handler<PreCompactInput, UniversalReturn>;
  postCompact?: Handler<PostCompactInput, UniversalReturn>;
  elicitation?: Handler<ElicitationInput, ElicitationReturn>;
  elicitationResult?: Handler<ElicitationResultInput, ElicitationResultReturn>;
}

// ============================================================================
// HookBlock — throwable to exit 2 with a reason
// ============================================================================

/**
 * Throw from a handler to exit with code 2 and write `reason` to stderr.
 * Effect depends on the event:
 *
 * - PreToolUse: blocks the tool call
 * - UserPromptSubmit: blocks the prompt
 * - PermissionRequest: denies permission
 * - Stop / SubagentStop: prevents stopping
 *
 * Non-blocking events treat this as a plain error.
 */
export class HookBlock extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HookBlock";
  }
}

// ============================================================================
// runHook — the main entrypoint
// ============================================================================

export interface RunHookOptions {
  /** Stream to read input JSON from. Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Stream to write output JSON to. Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Stream to write errors to. Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /**
   * Called instead of process.exit() — useful for tests. Defaults to
   * process.exit (in a real hook run) or a throwing fn (in tests if omitted
   * AND process.exit is unavailable).
   */
  exit?: (code: number) => never;
}

export async function runHook(
  handlers: HookHandlers,
  options: RunHookOptions = {},
): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });

  let input: HookInput;
  try {
    const raw = await readAll(stdin);
    input = JSON.parse(raw) as HookInput;
  } catch (err) {
    stderr.write(`claude-code-hooks: failed to parse stdin as JSON: ${String(err)}\n`);
    exit(1);
    return;
  }

  let output: HookOutput | undefined;
  try {
    output = await dispatch(handlers, input);
  } catch (err) {
    if (err instanceof HookBlock) {
      stderr.write(err.message);
      exit(2);
      return;
    }
    stderr.write(
      `claude-code-hooks: handler threw: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }\n`,
    );
    exit(1);
    return;
  }

  if (output !== undefined) {
    stdout.write(JSON.stringify(output));
  }
  exit(0);
}

// ============================================================================
// Dispatch — pure function, exported for testing
// ============================================================================

/**
 * Route a parsed hook input to the matching handler and assemble the
 * resulting HookOutput envelope. Pure function — does not touch stdin/stdout
 * or exit. Returns `undefined` when no handler applies.
 */
export async function dispatch(
  handlers: HookHandlers,
  input: HookInput,
): Promise<HookOutput | undefined> {
  switch (input.hook_event_name) {
    case "SessionStart":
      return wrap(
        "SessionStart",
        await callHandler(handlers.sessionStart, input),
      );

    case "SessionEnd":
      return wrap("SessionEnd", await callHandler(handlers.sessionEnd, input));

    case "UserPromptSubmit": {
      const ret = await callHandler(handlers.userPromptSubmit, input);
      return wrapBlockable("UserPromptSubmit", ret);
    }

    case "PreToolUse": {
      const handler = resolveToolHandler(handlers.preToolUse, input.tool_name);
      const ret = await callHandler(handler, input);
      return wrap("PreToolUse", ret);
    }

    case "PermissionRequest": {
      const handler = resolveToolHandler(handlers.permissionRequest, input.tool_name);
      const ret = await callHandler(handler, input);
      return wrap("PermissionRequest", ret);
    }

    case "PermissionDenied": {
      const handler = resolveToolHandler(handlers.permissionDenied, input.tool_name);
      const ret = await callHandler(handler, input);
      return wrap("PermissionDenied", ret);
    }

    case "PostToolUse": {
      const handler = resolveToolHandler(handlers.postToolUse, input.tool_name);
      const ret = await callHandler(handler, input);
      return wrapBlockable("PostToolUse", ret);
    }

    case "PostToolUseFailure": {
      const handler = resolveToolHandler(
        handlers.postToolUseFailure,
        input.tool_name,
      );
      const ret = await callHandler(handler, input);
      return wrapBlockable("PostToolUseFailure", ret);
    }

    case "Notification":
      return wrap("Notification", await callHandler(handlers.notification, input));

    case "SubagentStart":
      return wrap("SubagentStart", await callHandler(handlers.subagentStart, input));

    case "SubagentStop":
      return wrapBlockable(
        "SubagentStop",
        await callHandler(handlers.subagentStop, input),
      );

    case "TaskCreated":
      return wrap("TaskCreated", await callHandler(handlers.taskCreated, input));

    case "TaskCompleted":
      return wrap(
        "TaskCompleted",
        await callHandler(handlers.taskCompleted, input),
      );

    case "Stop":
      return wrapBlockable("Stop", await callHandler(handlers.stop, input));

    case "StopFailure":
      return wrap("StopFailure", await callHandler(handlers.stopFailure, input));

    case "TeammateIdle":
      return wrap(
        "TeammateIdle",
        await callHandler(handlers.teammateIdle, input),
      );

    case "InstructionsLoaded":
      return wrap(
        "InstructionsLoaded",
        await callHandler(handlers.instructionsLoaded, input),
      );

    case "ConfigChange":
      return wrapBlockable(
        "ConfigChange",
        await callHandler(handlers.configChange, input),
      );

    case "CwdChanged":
      return wrap("CwdChanged", await callHandler(handlers.cwdChanged, input));

    case "FileChanged":
      return wrap("FileChanged", await callHandler(handlers.fileChanged, input));

    case "WorktreeCreate": {
      const ret = await callHandler(handlers.worktreeCreate, input);
      return wrap("WorktreeCreate", ret);
    }

    case "WorktreeRemove":
      return wrap(
        "WorktreeRemove",
        await callHandler(handlers.worktreeRemove, input),
      );

    case "PreCompact":
      return wrap("PreCompact", await callHandler(handlers.preCompact, input));

    case "PostCompact":
      return wrap("PostCompact", await callHandler(handlers.postCompact, input));

    case "Elicitation":
      return wrap("Elicitation", await callHandler(handlers.elicitation, input));

    case "ElicitationResult":
      return wrap("ElicitationResult", await callHandler(handlers.elicitationResult, input));
  }
}

// ============================================================================
// Internals
// ============================================================================

const UNIVERSAL_KEYS = [
  "continue",
  "stopReason",
  "suppressOutput",
  "systemMessage",
] as const;


async function callHandler<I, R>(
  handler: Handler<I, R> | undefined,
  input: I,
): Promise<R | undefined> {
  if (!handler) return undefined;
  const out = await handler(input);
  return out ?? undefined;
}

function resolveToolHandler<I extends { tool_name: string }, R>(
  handler: Handler<I, R> | ToolHandlerMap<I, R> | undefined,
  toolName: string,
): Handler<I, R> | undefined {
  if (!handler) return undefined;
  if (typeof handler === "function") return handler;
  const map = handler as Record<string, Handler<I, R> | undefined>;
  return map[toolName] ?? map.default;
}

/** Keys that live on the top-level HookOutput, not inside hookSpecificOutput. */
const NON_SPECIFIC_KEYS = new Set<string>([...UNIVERSAL_KEYS, "block"]);

function pickHookSpecific(ret: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const k of Object.keys(ret)) {
    if (!NON_SPECIFIC_KEYS.has(k) && ret[k] !== undefined) picked[k] = ret[k];
  }
  return picked;
}

function wrap(
  eventName: string,
  ret: object | undefined,
): HookOutput | undefined {
  if (ret === undefined) return undefined;
  const retRec = ret as Record<string, unknown>;

  const output: HookOutput = {};

  for (const key of UNIVERSAL_KEYS) {
    const v = retRec[key];
    if (v !== undefined) {
      (output as Record<string, unknown>)[key] = v;
    }
  }

  const specific = pickHookSpecific(retRec);
  if (Object.keys(specific).length > 0) {
    output.hookSpecificOutput = {
      hookEventName: eventName,
      ...specific,
    } as unknown as NonNullable<HookOutput["hookSpecificOutput"]>;
  }

  return output;
}

/**
 * Wrap for events that support top-level `decision: "block"` with a `reason`.
 * If the handler returned `block: "..."`, translate it to that shape.
 */
function wrapBlockable(
  eventName: string,
  ret: object | undefined,
): HookOutput | undefined {
  if (ret === undefined) return undefined;
  const retRec = ret as Record<string, unknown>;

  const output = wrap(eventName, ret) ?? {};

  if (typeof retRec.block === "string") {
    output.decision = "block";
    output.reason = retRec.block;
  }

  return output;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  if (typeof (stream as { setEncoding?: (enc: string) => void }).setEncoding === "function") {
    (stream as { setEncoding: (enc: string) => void }).setEncoding("utf8");
  }
  let data = "";
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return data;
}
