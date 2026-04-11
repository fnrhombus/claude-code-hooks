import type {
  PreToolUseReturn,
  PostToolUseReturn,
  UserPromptSubmitReturn,
  UniversalReturn,
} from "./hook.js";

// ============================================================================
// PreToolUse convenience constructors
// ============================================================================

/** Allow the tool call to proceed unchanged. */
export const allow = (): PreToolUseReturn => ({ permissionDecision: "allow" });

/** Deny the tool call. Claude sees the reason and may retry. */
export const deny = (reason: string): PreToolUseReturn => ({
  permissionDecision: "deny",
  permissionDecisionReason: reason,
});

/** Ask the user for explicit permission before running the tool. */
export const ask = (reason: string): PreToolUseReturn => ({
  permissionDecision: "ask",
  permissionDecisionReason: reason,
});

/**
 * Rewrite the tool input in-flight. Claude never sees an error — the tool
 * runs with the new input as if Claude had generated it. This is the
 * lowest-token path for fix-ups.
 */
export const updateInput = (
  input: Record<string, unknown>,
  reason?: string,
): PreToolUseReturn => ({
  permissionDecision: "allow",
  updatedInput: input,
  ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
});

/**
 * Defer the tool call. The current Claude run exits and must be resumed
 * with `claude -p --resume <session-id>`, at which point the hook can
 * return `allow()` with updated input.
 */
export const defer = (reason?: string): PreToolUseReturn => ({
  permissionDecision: "defer",
  ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
});

// ============================================================================
// Context additions — work on any event that supports additionalContext
// ============================================================================

/** Add text to Claude's context without changing anything else. */
export const addContext = (text: string): { additionalContext: string } => ({
  additionalContext: text,
});

// ============================================================================
// Blocking — PostToolUse, UserPromptSubmit, Stop, SubagentStop, ConfigChange
// ============================================================================

/**
 * Block the event with a reason Claude (or the user) will see.
 * Translates to `{ decision: "block", reason }` in the hook output.
 */
export const block = (reason: string): { block: string } => ({ block: reason });

// ============================================================================
// Halt — stop Claude entirely, regardless of event
// ============================================================================

/** Halt execution entirely. Applies to all events. */
export const halt = (reason: string): UniversalReturn => ({
  continue: false,
  stopReason: reason,
});

// ============================================================================
// Session title — SessionStart / UserPromptSubmit
// ============================================================================

/** Set the session title (like `/rename`). */
export const setSessionTitle = (
  title: string,
): { sessionTitle: string } => ({ sessionTitle: title });

// Re-export the main wrapper types so `helpers` is fully self-describing.
export type { PreToolUseReturn, PostToolUseReturn, UserPromptSubmitReturn };
