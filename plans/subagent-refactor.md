# /ri Subagent Refactor — Implementation Plan

> Issue: [#1](https://github.com/sergey/www/pi-report-issue/issues/1) — `/ri` command should run as a subagent to preserve main context window

## Problem

Currently, the `/ri` command runs **inline** within the main conversation:

1. Diagnostics, issue formatting instructions, and tool output consume the main context window
2. The user is blocked from continuing their primary task while the issue is being created
3. The complex tool-gating mechanism (`session_start` + `agent_settled` listeners) is needed to prevent tool leakage

## Goal

Delegate the `/ri` workflow to a **subagent** (separate `pi` process) so that:

1. The main conversation context is **not polluted** with diagnostics, formatting instructions, or tool output
2. The user can **continue working** while the subagent creates the issue in the background
3. Only the **result** (issue URL, and in extended mode the root cause analysis) is reported back

## Approach

Use the same subprocess pattern as Pi's [subagent example](https://github.com/earendil/pi-coding-agent/tree/main/examples/extensions/subagent):

- Spawn a separate `pi --mode json -p --no-session` process
- The subprocess receives a focused one-shot task with diagnostics and issue instructions
- Parse JSON output from subprocess stdout to extract the result
- Report the issue URL back via `ctx.ui.notify`

The `create_github_issue` tool is **only active in the subprocess** — never in the main session. This eliminates the complex gating mechanism entirely.

---

## Architecture Comparison

### Before (current)
```
┌─ Main Pi Session ────────────────────────────────────────┐
│  User: /ri button broken                                  │
│       ↓                                                   │
│  /ri handler:                                             │
│    1. Parse args                                          │
│    2. Resolve repo                                        │
│    3. Collect diagnostics (fills context)                 │
│    4. Enable create_github_issue tool                     │
│    5. Send instructions to LLM (fills context)            │
│       ↓                                                   │
│  LLM: analyzes, calls create_github_issue                 │
│       ↓                                                   │
│  agent_settled: disable create_github_issue tool          │
│                                                           │
│  ⚠ Main context consumed: diagnostics + instructions     │
│  ⚠ User blocked during issue creation                     │
│  ⚠ Complex gating needed                                  │
└───────────────────────────────────────────────────────────┘
```

### After (proposed)
```
┌─ Main Pi Session ────────┐    ┌─ Subagent Process ─────────────┐
│  User: /ri button broken  │    │  pi --mode json -p --no-session│
│       ↓                   │    │  --tools create_github_issue    │
│  /ri handler:             │    │                                 │
│    1. Parse args          │    │  LLM receives:                  │
│    2. Resolve repo        │    │    - Diagnostics as context     │
│    3. Collect diagnostics │    │    - User's issue description   │
│    4. Spawn subagent ────►│    │    - Tool: create_github_issue  │
│    5. Notify "Creating..." │    │                                 │
│                           │    │  LLM: analyzes → calls tool     │
│  User continues working!  │    │       ↓                         │
│       ↓                   │    │  Result: issue URL              │
│  (Later) Result received  │◄───│  stdout: JSON message_end       │
│  Notify: "Issue created:  │    │                                 │
│    https://..."            │    │  ✅ Isolated context            │
│                           │    │  ✅ No gating needed            │
└───────────────────────────┘    └─────────────────────────────────┘
```

---

## Files Changed

| File | Change | Description |
|------|--------|-------------|
| `src/index.ts` | **Heavy refactor** | Remove gating mechanism; `/ri` spawns subagent instead of inline LLM |
| `src/subagent.ts` | **New file** | Subagent spawning, output parsing, and result extraction |
| `src/args.ts` | No change | Already handles flag parsing |
| `src/diagnostics.ts` | No change | Already collects project context |
| `src/github.ts` | No change | Already resolves target repo |
| `README.md` | Update | Document new architecture |
| `CHANGELOG.md` | Update | Add entry |

---

## Phase 1: Subagent Infrastructure (`src/subagent.ts`)

### 1.1 Spawning Logic

Inspired by the Pi subagent example (`runSingleAgent`), but simplified for our single-purpose use case:

```typescript
// src/subagent.ts

import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";

export interface SubagentResult {
  success: boolean;
  issueUrl?: string;
  error?: string;
  rawOutput?: string;
}

/**
 * Spawns a pi subprocess to create a GitHub issue.
 *
 * The subprocess runs with:
 *   - PI_REPORT_ISSUE_SUBAGENT=true env var (signals subagent mode)
 *   - --mode json -p --no-session (one-shot, JSON output, no persistence)
 *   - Current extension loaded via -e (provides create_github_issue tool)
 *   - create_github_issue in --tools allowlist
 *
 * @param cwd - Working directory for the subprocess
 * @param task - One-shot task with diagnostics and instructions
 * @param signal - AbortSignal for cancellation
 * @returns Parsed result with issue URL or error
 */
export async function spawnIssueSubagent(
  cwd: string,
  task: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const piPath = resolvePiPath();
  const extensionPath = resolveExtensionPath();

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "-e", extensionPath,
    "--tools", "create_github_issue",
    task,
  ];

  const env = { ...process.env, PI_REPORT_ISSUE_SUBAGENT: "true" };

  return new Promise((resolve) => {
    const proc = spawn(piPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const messages: Message[] = [];
    let buffer = "";
    let stderr = "";
    let lastAssistantText = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Capture message_end events
          if (event.type === "message_end" && event.message) {
            const msg = event.message as Message;
            messages.push(msg);

            if (msg.role === "assistant") {
              // Extract text from assistant messages
              for (const part of msg.content) {
                if (part.type === "text") {
                  lastAssistantText = part.text;
                }
              }
            }
          }

          // Capture tool results (for create_github_issue output)
          if (event.type === "tool_result_end" && event.message) {
            messages.push(event.message as Message);
          }
        } catch {
          // Ignore unparseable lines
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          if (event.type === "message_end" && event.message) {
            messages.push(event.message);
          }
        } catch { /* ignore */ }
      }

      if (code !== 0) {
        resolve({
          success: false,
          error: stderr || `Subprocess exited with code ${code}`,
          rawOutput: lastAssistantText,
        });
        return;
      }

      // Extract issue URL from tool results or assistant text
      const issueUrl = extractIssueUrl(messages, lastAssistantText);

      if (issueUrl) {
        resolve({ success: true, issueUrl, rawOutput: lastAssistantText });
      } else {
        resolve({
          success: false,
          error: "No issue URL found in subagent output",
          rawOutput: lastAssistantText || stderr,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        error: `Failed to spawn subagent: ${err.message}`,
      });
    });

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

/**
 * Extracts the GitHub issue URL from subagent output.
 * Checks tool result details first, then falls back to parsing text.
 */
function extractIssueUrl(messages: Message[], fallbackText: string): string | undefined {
  // Check tool results for create_github_issue output
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      for (const part of msg.content) {
        if (part.type === "toolResult" && part.content) {
          // Tool content may be array of content blocks
          const blocks = Array.isArray(part.content) ? part.content : [part.content];
          for (const block of blocks) {
            if (typeof block === "object" && block !== null && "text" in block) {
              const match = (block as { text: string }).text.match(
                /(https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+)/
              );
              if (match) return match[1];
            }
          }
        }
      }
    }
  }

  // Fallback: parse from last assistant text
  const match = fallbackText.match(
    /(https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+)/
  );
  return match?.[1];
}

/** Resolves the pi binary path. */
function resolvePiPath(): string {
  return process.argv[1] || "pi";
}

/** Resolves the path to this extension's entry point. */
function resolveExtensionPath(): string {
  // Use __dirname equivalent for ESM
  return new URL("../src/index.ts", import.meta.url).pathname;
}
```

### 1.2 Key Design Decisions

- **Environment variable gating:** `PI_REPORT_ISSUE_SUBAGENT=true` signals subagent mode. The `src/index.ts` checks this and skips tool gating when set.
- **`--tools create_github_issue`:** Explicitly allows only the needed custom tool (plus default built-ins for extended mode analysis).
- **JSON mode parsing:** Parses `message_end` and `tool_result_end` events to extract the issue URL from tool output.
- **Issue URL extraction:** Checks tool result details first (structured), falls back to regex on assistant text.
- **AbortSignal support:** Parent can cancel subprocess.

---

## Phase 2: Refactor `src/index.ts`

### 2.1 Remove Gating Mechanism

The current gating:
```typescript
// REMOVE:
pi.on("session_start", () => { ... disable tool ... });
pi.on("agent_settled", () => { ... disable tool ... });
```

Replace with environment-aware initialization:
```typescript
// NEW: Only gate in the main process (not subagent)
if (!process.env.PI_REPORT_ISSUE_SUBAGENT) {
  // In the main process: never enable create_github_issue
  pi.on("session_start", () => {
    pi.setActiveTools(
      pi.getActiveTools().filter((t) => t !== "create_github_issue")
    );
  });
}
// In subagent: tool stays active (registered by registerTool, then auto-active)
```

### 2.2 Refactor `/ri` Handler

```typescript
pi.registerCommand("ri", {
  description: "Report a GitHub issue. Usage: /ri [-e] [--repo=owner/name|parent] <description>",
  handler: async (args, ctx) => {
    // 1. Parse flags
    const parsed = parseArgs(args.trim());
    if ("error" in parsed) {
      ctx.ui.notify(parsed.error, "error");
      return;
    }
    if (!parsed.message) {
      ctx.ui.notify(
        "Usage: /ri [-e] [--repo=owner/name|parent] <description>",
        "warning",
      );
      return;
    }

    // 2. Pre-flight: check gh CLI
    const ghCheck = await pi.exec("gh", ["--version"], { timeout: 5_000 });
    if (ghCheck.code !== 0) {
      ctx.ui.notify("GitHub CLI (gh) is not installed or not in PATH.", "error");
      return;
    }

    if (parsed.repo === "parent") {
      const authCheck = await pi.exec("gh", ["auth", "status"], { timeout: 5_000 });
      if (authCheck.code !== 0) {
        ctx.ui.notify(
          "gh is not authenticated. Run 'gh auth login' to authenticate with GitHub.",
          "error",
        );
        return;
      }
    }

    // 3. Resolve repo
    const repo = await resolveGitHubRepo(pi, ctx.cwd, parsed.repo);
    if (!repo.ok) {
      ctx.ui.notify(repo.error, "error");
      return;
    }

    // 4. Collect diagnostics (still runs in main process — cheap operations)
    const diagnosticsMd = await collectDiagnostics(pi, ctx.cwd);

    // 5. Build the subagent task
    const extendedTasks = parsed.extended
      ? `6. AFTER creating the issue, search the codebase for the root cause of the problem. Use read/grep tools to examine relevant source files. Trace the issue to specific code.\n` +
        `7. Include a "## Root Cause Analysis" section in the issue body when creating it. Add file paths, line numbers, and a clear explanation.\n` +
        `8. If a fix is obvious and safe, include a "## Proposed Fix" section in the issue body. Do NOT apply the fix — only document it.\n`
      : "";

    const stopInstruction = parsed.extended
      ? `9. Report your findings to the user. Do NOT edit any source files.\n`
      : `6. STOP. Report the issue URL to the user. Do NOT fix the issue. Do NOT edit any source files. Do NOT update CHANGELOG.md, README.md, or AGENTS.md. The user will handle the fix separately.\n`;

    const task = [
      `The user reported an issue for **${repo.repo}**.`,
      ``,
      `User's message:`,
      `"""`,
      parsed.message,
      `"""`,
      ``,
      `Your task:`,
      `1. Analyze the message — is this a **bug report** or **feature request**?`,
      `2. Create a concise, descriptive issue title (max 80 chars)`,
      `3. Enhance the description: add clarity, context, steps to reproduce (for bugs) or use case (for features). Keep it in the user's voice.`,
      `4. Call the **create_github_issue** tool with repo="${repo.repo}", title, body, and label ("bug" or "enhancement").`,
      extendedTasks,
      stopInstruction,
      `Project context for your analysis (use this to write a better issue — do NOT copy this into the issue body verbatim):`,
      ``,
      diagnosticsMd,
    ].join("\n");

    // 6. Notify user
    ctx.ui.notify(
      `Creating issue on ${repo.repo}${parsed.extended ? " (extended)" : ""}...`,
      "info",
    );

    // 7. Spawn subagent (fire and forget — result handled in callback)
    spawnIssueSubagent(ctx.cwd, task).then((result) => {
      if (result.success && result.issueUrl) {
        ctx.ui.notify(`Issue created: ${result.issueUrl}`, "success");
      } else {
        ctx.ui.notify(
          `Failed to create issue: ${result.error || "Unknown error"}`,
          "error",
        );
      }
    });
  },
});
```

### 2.3 Remaining Tool Registration

The `create_github_issue` tool stays registered (unchanged from current) but:
- **Runtime guard** now checks `PI_REPORT_ISSUE_SUBAGENT` instead of `pi.getActiveTools()`:
  ```typescript
  if (!process.env.PI_REPORT_ISSUE_SUBAGENT) {
    throw new Error(
      "create_github_issue is gated. It can only be called during a /ri command flow."
    );
  }
  ```
- The `agent_settled` listener and `session_start` tool removal are **gone**.

---

## Phase 3: Polish & Edge Cases

### 3.1 Visual Feedback

- `/ri` handler shows "Creating issue..." notification immediately
- On completion: success notification with issue URL or error notification
- The user is **not blocked** — they can continue chatting

### 3.2 Extended Mode (`-e`)

Extended mode works in the subagent because the subprocess has default built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). The LLM can search the codebase before calling `create_github_issue`.

The `--tools create_github_issue` flag does NOT restrict built-in tools — it only adds custom tools to the allowlist. Built-in tools are always available unless excluded.

### 3.3 Error Handling

| Scenario | Handling |
|----------|----------|
| Subprocess fails to spawn | `spawn` error → `SubagentResult.error` → error notification |
| Subprocess exits non-zero | `code !== 0` → `SubagentResult.error` with stderr → error notification |
| No issue URL in output | `extractIssueUrl` returns undefined → error notification |
| `gh` not installed | Caught by pre-flight in main process before spawning |
| `gh` not authenticated | Caught by pre-flight (for `--repo=parent`) or by subprocess error |
| User interrupts /ri | AbortSignal passed to subprocess (future enhancement) |

### 3.4 Compatibility Notes

- **Multiple `/ri` concurrent invocations:** Each spawns an independent subprocess. Safe — no shared state.
- **Subprocess lifetime:** Subprocess completes its one-shot task and exits. No cleanup needed.
- **Environment:** Subprocess inherits `process.env` plus `PI_REPORT_ISSUE_SUBAGENT=true`. This means `gh` auth, `GITHUB_TOKEN`, etc. are available.

---

## Acceptance Criteria

- [x] `/ri` triggers a subagent workflow instead of running inline
- [x] Main conversation context is not consumed by diagnostics or issue-creation instructions
- [x] User can continue chatting during issue creation
- [x] Result (issue URL) is reported back when done
- [x] Extended mode (`-e`) root cause analysis still works within the subagent
- [x] `create_github_issue` tool is only active within the subagent, never in the main session
- [x] Complex gating mechanism (`agent_settled` + `session_start` listeners) is removed
- [x] Pre-flight checks (gh CLI, gh auth) still run in main process for fast error feedback

---

## Implementation Order

1. **Create `src/subagent.ts`** — spawn logic, JSON parsing, URL extraction
2. **Refactor `src/index.ts`** — remove gating, replace inline LLM with subagent spawn
3. **Update `create_github_issue` runtime guard** — use env var instead of `pi.getActiveTools()`
4. **Update `README.md`** — document new architecture
5. **Update `CHANGELOG.md`** — add entry
6. **Test manually** — all scenarios from original plan

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Subprocess startup latency | Diagnostics collection is still in main process; subprocess starts quickly with pre-built task |
| JSON output parsing fragility | Regex fallback for URL extraction; `message_end` events are reliable in JSON mode |
| Extension path resolution in ESM | Use `import.meta.url` for path resolution |
| `process.argv[1]` might not point to pi | Fall back to `"pi"` command (PATH lookup) |
