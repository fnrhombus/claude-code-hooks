/**
 * dev-cycle.ts — autonomous type-sync pipeline for @fnrhombus/claude-code-hooks
 *
 * Designed to be invoked by a scheduled task with zero human interaction needed
 * on the happy path. Runs on Node (via tsx) so it works identically on Windows,
 * macOS, and Linux — the thin entrypoints (./scripts/dev-cycle and
 * dev-cycle.cmd) just delegate here via `pnpm exec tsx`.
 *
 * Flow:
 *   1. Run the regen-hook-types skill via `claude -p`
 *   2. If upstream hash unchanged, exit clean (exit 0)
 *   3. Find or create a tracking issue for the new hash
 *   4. Create a feature branch + git worktree
 *   5. TDD loop: test → fix → test, up to MAX_TDD_ATTEMPTS times
 *   6. On failure: research then retry MAX_POST_RESEARCH_ATTEMPTS more times
 *   7. On still-failure: update BLOCKERS.md, assign issue, exit 3
 *   8. On success: push, open PR, wait for CI, run PR review, merge, cleanup
 *
 * Env overrides:
 *   DEV_CYCLE_REPO_DIR    Repo root (default: process.cwd())
 *   DEV_CYCLE_DRY_RUN     "1" to skip gh/git push operations
 *   DEV_CYCLE_SKIP_PR     "1" to stop after the branch is ready locally
 *
 * Exit codes:
 *   0  no change, or merged successfully
 *   1  unexpected error
 *   2  regen skill failed
 *   3  TDD loop gave up; issue filed, BLOCKERS.md updated
 *   4  CI failed on the PR
 *   5  PR review rejected
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const REPO_DIR = resolve(
  process.env.DEV_CYCLE_REPO_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const TYPES_FILE = "packages/core/src/types.ts";
const BLOCKERS_FILE = "BLOCKERS.md";
const STATE_DIR = ".dev-cycle-state";
const MAX_TDD_ATTEMPTS = 5;
const MAX_POST_RESEARCH_ATTEMPTS = 3;
const ASSIGNEE = "fnrhombus";
const MAIN_BRANCH = "main";

const DRY_RUN = process.env.DEV_CYCLE_DRY_RUN === "1";
const SKIP_PR = process.env.DEV_CYCLE_SKIP_PR === "1";

process.chdir(REPO_DIR);
mkdirSync(STATE_DIR, { recursive: true });

// ----------------------------------------------------------------------------
// Logging
// ----------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}
function step(msg: string): void {
  log("");
  log(`=== ${msg} ===`);
}
function die(msg: string): never {
  log(`FATAL: ${msg}`);
  process.exit(1);
}

// ----------------------------------------------------------------------------
// Shell helpers
// ----------------------------------------------------------------------------

interface CaptureOptions {
  allowFailure?: boolean;
  input?: string;
}

interface CaptureResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command, inherit stdio, throw on non-zero exit.
 * Returns nothing — use this when you only care that it worked.
 */
function run(cmd: string, args: string[], options: SpawnSyncOptions = {}): void {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
  }
}

/**
 * Run a command, capture stdout, return it. Throws on non-zero exit unless
 * `allowFailure: true` is passed.
 */
function capture(
  cmd: string,
  args: string[],
  { allowFailure = false, input }: CaptureOptions = {},
): CaptureResult {
  const res = spawnSync(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  if (res.status !== 0 && !allowFailure) {
    const stderr = (res.stderr ?? "").toString().trim();
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${res.status}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  return {
    status: res.status ?? -1,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
  };
}

/** Run a command and return true on exit 0, false otherwise. Stdout inherited. */
function tryRun(cmd: string, args: string[], options: SpawnSyncOptions = {}): boolean {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...options });
  return res.status === 0;
}

// ----------------------------------------------------------------------------
// Claude invocation
// ----------------------------------------------------------------------------

/**
 * Run `claude -p` with a prompt. Returns the text output.
 * Uses --output-format text so output is parseable (no JSON wrapping).
 */
function claudeRun(
  prompt: string,
  { allowFailure = false }: { allowFailure?: boolean } = {},
): string {
  // The pipeline runs unattended (scheduled task). Permission prompts would
  // deadlock it, so we skip them. This is safe because the pipeline only runs
  // on its own feature branches inside a worktree — never on main directly.
  const res = capture(
    "claude",
    [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
      prompt,
    ],
    { allowFailure },
  );
  return res.stdout.trim();
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

/** Extract the SOURCE_SHA256 from line 1 of a types file, or "" if absent. */
function readSourceHash(file: string): string {
  if (!existsSync(file)) return "";
  const firstLine = readFileSync(file, "utf8").split(/\r?\n/)[0] ?? "";
  const match = firstLine.match(/^\/\/ SOURCE_SHA256: ([0-9a-f]{64})$/);
  return match?.[1] ?? "";
}

/** Check whether a tracking issue for a given upstream hash already exists. */
function findIssueForHash(hash: string): number | null {
  const res = capture(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "all",
      "--search",
      `in:body ${hash}`,
      "--json",
      "number",
      "--jq",
      ".[0].number // empty",
    ],
    { allowFailure: true },
  );
  const n = res.stdout.trim();
  return n ? Number(n) : null;
}

function saveState(key: string, value: string | number): void {
  writeFileSync(join(STATE_DIR, key), String(value));
}

// ----------------------------------------------------------------------------
// Pipeline steps
// ----------------------------------------------------------------------------

step("Step 1: Running regen-hook-types skill");

const oldHash = readSourceHash(TYPES_FILE);
log(`current types file hash: ${oldHash || "<none>"}`);

try {
  claudeRun("Run the regen-hook-types skill. Do not do anything else.");
} catch (err) {
  log(`claude invocation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const newHash = readSourceHash(TYPES_FILE);
if (!newHash) {
  die("types file has no SOURCE_SHA256 header after regen");
}

if (oldHash === newHash) {
  log("types are up to date — nothing to do");
  rmSync(STATE_DIR, { recursive: true, force: true });
  process.exit(0);
}

log(`upstream changed: ${oldHash || "<none>"} → ${newHash}`);

// The skill wrote to the working tree on main. Revert — we'll re-apply inside
// a feature branch worktree.
run("git", ["checkout", "--", TYPES_FILE]);
log(`reverted types file on ${MAIN_BRANCH} — will re-apply in feature branch`);

// ----------------------------------------------------------------------------

step("Step 2: Ensuring tracking issue exists");

let issueNumber: number | string | null = findIssueForHash(newHash);
if (issueNumber) {
  log(`existing issue #${issueNumber} already tracks sha256 ${newHash}`);
} else if (DRY_RUN) {
  log(`DRY_RUN: would create issue for ${newHash}`);
  issueNumber = "DRY-RUN";
} else {
  const issueBody =
    `The upstream Claude Code hooks documentation changed.\n\n` +
    `- **previous hash:** \`${oldHash || "<none>"}\`\n` +
    `- **new hash:** \`${newHash}\`\n` +
    `- **source:** https://code.claude.com/docs/en/hooks.md\n` +
    `- **triggered by:** \`scripts/dev-cycle\` at ${new Date().toISOString()}\n\n` +
    `This issue is tracked automatically. A feature branch will be opened to ` +
    `regenerate \`${TYPES_FILE}\` and fix any downstream breakage.\n`;

  // Labels may or may not exist; fall back to unlabeled on failure.
  const titleHash = newHash.slice(0, 8);
  const title = `Sync hook types: upstream changed (${titleHash})`;
  const withLabels = capture(
    "gh",
    ["issue", "create", "--title", title, "--body", issueBody, "--label", "automated,type-sync"],
    { allowFailure: true },
  );
  const result =
    withLabels.status === 0
      ? withLabels
      : capture("gh", ["issue", "create", "--title", title, "--body", issueBody]);
  const url = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  issueNumber = Number(url.split("/").pop());
  log(`created issue #${issueNumber}`);
}
saveState("issue-number", issueNumber);

// ----------------------------------------------------------------------------

step("Step 3: Creating feature branch and worktree");

const branch = `sync/hook-types-${newHash.slice(0, 8)}`;
const worktreeDir = resolve("..", `claude-code-hooks-${branch.replace(/\//g, "-")}`);

const existingWorktrees = capture("git", ["worktree", "list"]).stdout;
if (existingWorktrees.includes(worktreeDir)) {
  log(`reusing existing worktree at ${worktreeDir}`);
} else {
  run("git", ["fetch", "origin", MAIN_BRANCH]);
  run("git", ["worktree", "add", worktreeDir, "-b", branch, `origin/${MAIN_BRANCH}`]);
  log(`created worktree at ${worktreeDir} on branch ${branch}`);
}
saveState("branch", branch);
saveState("worktree", worktreeDir);

// All subsequent work happens in the worktree.
process.chdir(worktreeDir);

// ----------------------------------------------------------------------------

step("Step 4: Regenerating types in worktree");

claudeRun("Run the regen-hook-types skill. Do not do anything else.");

const regenHash = readSourceHash(TYPES_FILE);
if (regenHash !== newHash) {
  die(`worktree regen produced unexpected hash: ${regenHash} != ${newHash}`);
}

run("git", ["add", TYPES_FILE]);
run("git", [
  "commit",
  "-m",
  `regen: update hook types to upstream ${newHash}\n\n` +
    `Upstream hook doc changed.\n` +
    `- previous: ${oldHash || "<none>"}\n` +
    `- new:      ${newHash}\n\n` +
    `Refs #${issueNumber}`,
]);
log("committed regenerated types");

// ----------------------------------------------------------------------------

step(`Step 5: TDD loop (up to ${MAX_TDD_ATTEMPTS} attempts)`);

function runTests() {
  // Try frozen lockfile first; fall back to regular install if it drifts.
  const installed =
    tryRun("pnpm", ["install", "--frozen-lockfile"]) ||
    tryRun("pnpm", ["install"]);
  if (!installed) return false;
  if (!tryRun("pnpm", ["-r", "typecheck"])) return false;
  if (!tryRun("pnpm", ["--filter", "@fnrhombus/claude-code-hooks", "build"])) return false;
  if (!tryRun("pnpm", ["--filter", "claude-code-hooks-tests", "test"])) return false;
  return true;
}

let success = false;
for (let attempt = 1; attempt <= MAX_TDD_ATTEMPTS && !success; attempt++) {
  log(`attempt ${attempt}/${MAX_TDD_ATTEMPTS}`);
  if (runTests()) {
    success = true;
    break;
  }
  log("build/test failed — asking claude to fix");
  claudeRun(
    `pnpm test, pnpm -r typecheck, or pnpm build failed after regenerating ${TYPES_FILE}. ` +
      `Read the failures, fix the wrapper code in packages/core/src/hook.ts and packages/core/src/helpers.ts, ` +
      `or update tests in packages/tests/src/ to match new upstream types. ` +
      `Do NOT modify ${TYPES_FILE} — it is authoritative. Do NOT commit. ` +
      `When you believe everything is fixed, stop.`,
    { allowFailure: true },
  );
}

if (!success) {
  step(`Step 5b: Research phase (post-${MAX_TDD_ATTEMPTS} failed attempts)`);
  claudeRun(
    `The TDD loop has failed ${MAX_TDD_ATTEMPTS} times. Research the failure: ` +
      `use WebFetch or WebSearch to check the upstream hooks.md for semantic changes, ` +
      `look at related github issues on anthropics/claude-code, and examine the diff between ` +
      `the old and new types. Write a 200-word findings report to ${STATE_DIR}/research.md. ` +
      `Do not touch code yet.`,
    { allowFailure: true },
  );

  for (let attempt = 1; attempt <= MAX_POST_RESEARCH_ATTEMPTS && !success; attempt++) {
    log(`post-research attempt ${attempt}/${MAX_POST_RESEARCH_ATTEMPTS}`);
    if (runTests()) {
      success = true;
      break;
    }
    claudeRun(
      `Post-research fix attempt ${attempt}/${MAX_POST_RESEARCH_ATTEMPTS}. ` +
        `Read ${STATE_DIR}/research.md. Apply what you learned to fix the build. ` +
        `Do NOT modify ${TYPES_FILE}. Do NOT commit.`,
      { allowFailure: true },
    );
  }
}

if (!success) {
  step("Step 5c: Giving up — filing BLOCKERS entry");
  process.chdir(REPO_DIR);

  const totalAttempts = MAX_TDD_ATTEMPTS + MAX_POST_RESEARCH_ATTEMPTS;
  const entry =
    `\n## ${new Date().toISOString().slice(0, 10)} — sha256 ${newHash} (issue #${issueNumber})\n\n` +
    `Auto-sync for upstream hash \`${newHash}\` failed after ${totalAttempts} attempts.\n` +
    `See [#${issueNumber}](https://github.com/fnrhombus/claude-code-hooks/issues/${issueNumber}).\n`;

  const existing = existsSync(BLOCKERS_FILE) ? readFileSync(BLOCKERS_FILE, "utf8") : "# Blockers\n\nLong-standing issues the auto-sync pipeline couldn't handle.\n";
  writeFileSync(BLOCKERS_FILE, existing + entry);

  if (!DRY_RUN) {
    run("git", ["add", BLOCKERS_FILE]);
    run("git", [
      "commit",
      "-m",
      `docs(blockers): auto-sync failed for ${newHash}\n\nRefs #${issueNumber}`,
    ]);
    tryRun("git", ["push", "origin", MAIN_BRANCH]);

    tryRun("gh", ["issue", "edit", String(issueNumber), "--add-assignee", ASSIGNEE]);
    tryRun("gh", [
      "issue",
      "comment",
      String(issueNumber),
      "--body",
      `Auto-sync gave up after ${totalAttempts} attempts. Assigning to @${ASSIGNEE}. ` +
        `Worktree at ${worktreeDir} left intact for manual inspection; state files in ${STATE_DIR}/.`,
    ]);
  }

  log(`gave up — issue #${issueNumber} assigned, BLOCKERS.md updated`);
  process.exit(3);
}

log("TDD loop passed");

// ----------------------------------------------------------------------------

if (SKIP_PR) {
  log("DEV_CYCLE_SKIP_PR set — stopping after local branch is ready");
  process.exit(0);
}

step("Step 6: Pushing branch and opening PR");

if (DRY_RUN) {
  log(`DRY_RUN: would push ${branch} and open PR`);
  process.exit(0);
}

run("git", ["push", "-u", "origin", branch]);

const prBody =
  `Automated type sync triggered by upstream hook doc change.\n\n` +
  `- **previous:** \`${oldHash || "<none>"}\`\n` +
  `- **new:** \`${newHash}\`\n` +
  `- **source:** https://code.claude.com/docs/en/hooks.md\n\n` +
  `Closes #${issueNumber}\n`;

const prTitle = `regen: sync hook types to upstream ${newHash.slice(0, 8)}`;
const prRes = capture("gh", [
  "pr",
  "create",
  "--base",
  MAIN_BRANCH,
  "--head",
  branch,
  "--title",
  prTitle,
  "--body",
  prBody,
  "--label",
  "automated,type-sync",
]);
const prUrl = prRes.stdout.trim().split(/\r?\n/).pop() ?? "";
const prNumber = Number(prUrl.split("/").pop());
saveState("pr-number", prNumber);
log(`opened PR #${prNumber} at ${prUrl}`);

// ----------------------------------------------------------------------------

step("Step 7: Waiting for CI");

if (!tryRun("gh", ["pr", "checks", String(prNumber), "--watch", "--fail-fast"])) {
  log("CI failed");
  tryRun("gh", [
    "issue",
    "comment",
    String(issueNumber),
    "--body",
    `CI failed on PR #${prNumber}. Re-run \`scripts/dev-cycle\` after investigation, or fix manually.`,
  ]);
  process.exit(4);
}
log("CI passed");

// ----------------------------------------------------------------------------

step("Step 8: PR review");

const review = claudeRun(
  `You are reviewing PR #${prNumber} on fnrhombus/claude-code-hooks. ` +
    `Use 'gh pr view ${prNumber}' and 'gh pr diff ${prNumber}' to see the changes. ` +
    `This is an automated type-sync PR triggered by an upstream Claude Code hooks doc change. ` +
    `Check: (1) the sha256 header is present and matches the new upstream hash, ` +
    `(2) no hand-edits to ${TYPES_FILE} beyond the regen, ` +
    `(3) the wrapper in hook.ts and helpers.ts still compiles and the tests cover the new ` +
    `event types if any were added, ` +
    `(4) no accidental breaking changes to the public API beyond what the upstream change requires. ` +
    `Reply with exactly 'LGTM' on its own line if you approve, or a paragraph explaining what's wrong.`,
);

if (!/^LGTM$/m.test(review)) {
  log("PR review rejected");
  tryRun("gh", ["pr", "comment", String(prNumber), "--body", `Automated review did not approve:\n\n${review}`]);
  tryRun("gh", [
    "issue",
    "comment",
    String(issueNumber),
    "--body",
    `PR review rejected automated sync. See PR #${prNumber} comment for details.`,
  ]);
  process.exit(5);
}
log("PR review approved");

// ----------------------------------------------------------------------------

step("Step 9: Merging and cleanup");

run("gh", ["pr", "merge", String(prNumber), "--squash", "--delete-branch"]);
log("merged and deleted remote branch");

process.chdir(REPO_DIR);
tryRun("git", ["worktree", "remove", worktreeDir, "--force"]);
log(`removed worktree ${worktreeDir}`);

rmSync(STATE_DIR, { recursive: true, force: true });
log(`dev-cycle complete for ${newHash}`);
process.exit(0);
