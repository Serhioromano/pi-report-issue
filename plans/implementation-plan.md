# Pi Report Issue Extension — Implementation Plan

## Overview

A pi agent extension that adds a `/ri` (Report Issue) command. The user types a short description, the extension hands it off to pi's LLM for analysis, and the LLM calls a gated custom tool to create a properly formatted GitHub issue on the **target** repository via `gh issue create`. The target repository defaults to the current project's GitHub remote, but can be overridden via `--repo=` flag (including `--repo=parent` for fork parent). An `-e`/`--extended` flag enables deep code analysis and proposed fixes (without applying them).

## Design

### Architecture

Three entry points:

1. **`/ri` command** — registered via `pi.registerCommand()`. Entry point for the user. Parses flags (`--repo=`, `-e`/`--extended`) from the message, resolves the target repository, collects diagnostics and enables the gated tool.
2. **`create_github_issue` tool** — registered via `pi.registerTool()` but **gated**: disabled by default, enabled only during the `/ri` flow via `pi.setActiveTools()` and disabled again after the turn completes. The LLM can only see and call it when responding to a `/ri` command.
3. **`src/args.ts`** — argument parser that extracts `--repo=...`, `-e`/`--extended` flags from raw user input, returning the cleaned message and parsed options.

### Gating Strategy

The `create_github_issue` tool is kept disabled by default. The `/ri` handler enables it before sending instructions to the LLM. An `agent_settled` listener disables it after the turn completes. This prevents the LLM from creating issues outside the `/ri` workflow — e.g., if the user says "create an issue about X" without `/ri`, the tool is invisible and cannot be called.

### Workflow (default mode, no `-e`)

```
User: /ri This button doesn't work
  ↓
Command handler:
  1. Parse flags from args (--repo=, -e) — extract clean message
  2. Resolve target GitHub repo (current / --repo= / --repo=parent)
  3. Pre-flight: check gh CLI is installed; if --repo=parent also check gh auth status
  4. Enable create_github_issue tool via setActiveTools()
  5. Collect diagnostics as AI context (branch, recent commits, project structure)
  6. Call pi.sendUserMessage() with analysis instructions AND diagnostics as context
  ↓
LLM (report-only instructions):
  1. Analyzes message → bug or feature request
  2. Creates concise title (max 80 chars)
  3. Enhances description with context/steps/use-case — use diagnostics for context only, don't append them
  4. Calls create_github_issue tool with { repo, title, body, label }
  5. Reports the issue URL to the user. Does NOT fix or edit source files.
  ↓
agent_settled listener:
  1. Disables create_github_issue tool via setActiveTools()
```

### Workflow (extended mode, `-e` flag)

```
User: /ri -e This button doesn't work
  ↓
Command handler:
  Same steps 1-5 as default, but with extended flag set
  ↓
LLM (extended instructions):
  1. Same analysis + issue creation as default (diagnostics as context, not in body)
  2. THEN: search the codebase for the root cause (read/grep tools)
  3. Include root cause analysis in the issue body when creating it
  4. If a clear fix is found, include a proposed fix in the issue body
  5. Does NOT apply the fix — only documents findings
```

### Deliverables

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry point (command + tool + gating) |
| `src/args.ts` | Argument parser for `/ri` flags |
| `src/github.ts` | GitHub repo resolution (current, --repo=, --repo=parent) |
| `src/diagnostics.ts` | Collect project context for AI analysis (not appended to issues) |
| `package.json` | Package metadata with `pi.extensions` field |
| `biome.json` | Biome linter/formatter configuration |
| `.vscode/settings.json` | VS Code integration (Biome as default formatter) |
| `.gitignore` | Ignore patterns |
| `.npmignore` | npm publish exclusions |
| `README.md` | Installation and usage documentation |
| `CHANGELOG.md` | Version history |

---

## Phase 1: Project Skeleton

### 1.1 Initialize project structure

```
pi-report-issue/
├── src/
│   ├── index.ts
│   ├── args.ts
│   ├── github.ts
│   └── diagnostics.ts
├── .vscode/
│   └── settings.json
├── plans/
│   └── implementation-plan.md  ← this file
├── .gitignore
├── .npmignore
├── package.json
├── biome.json
├── README.md
└── CHANGELOG.md
```

### 1.2 `package.json`

```json
{
  "name": "pi-report-issue",
  "version": "0.1.0",
  "type": "module",
  "description": "Pi extension to report GitHub issues from the chat using /ri command",
  "keywords": [
    "pi",
    "ai-agent",
    "pi-extension",
    "pi-package",
    "github"
  ],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "scripts": {
    "lint": "biome lint src/",
    "format": "biome format --write src/",
    "check": "biome check src/"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0"
  },
  "dependencies": {}
}
```

Key `package.json` decisions:
- `type: "module"` — pi extensions run via jiti with ESM support
- `pi.extensions: ["./src/index.ts"]` — entry point for pi's auto-discovery
- `@biomejs/biome` as devDependency — used by VS Code and scripts
- No runtime npm dependencies needed — we use only `pi.exec()` and node built-ins
- `"private"` omitted — package is public

### 1.3 `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "indentWidth": 2
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "organizeImports": {
    "enabled": true
  }
}
```

### 1.4 `.vscode/settings.json`

```json
{
  "recommendations": ["biomejs.biome"],
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.organizeImports.biome": "explicit"
  },
  "[typescript]": {
    "editor.defaultFormatter": "biomejs.biome"
  },
  "[json]": {
    "editor.defaultFormatter": "biomejs.biome"
  }
}
```

### 1.5 `.gitignore`

```
node_modules/
dist/
*.log
.DS_Store
```

### 1.6 `.npmignore`

```
src/
plans/
.vscode/
.gitignore
biome.json
node_modules/
```

### 1.7 `CHANGELOG.md`

```markdown
# Changelog

## [0.1.0] - Unreleased

### Added
- `/ri` command to report GitHub issues from the chat
- `create_github_issue` gated tool for issue creation via `gh` CLI
- Support for `--repo=<owner/name>` and `--repo=parent` flags
- Extended mode (`-e`/`--extended`) for root cause analysis
- Diagnostics collection (branch, recent commits, uncommitted changes, project overview)
```

---

## Phase 2: Core Extension Logic

### 2.1 `src/args.ts` — Argument Parser

Parses flags from the raw `/ri` command input and returns the cleaned user message.

```typescript
// Types:
// - ParsedArgs = { message: string; repo?: string; extended: boolean }
//     message: cleaned user description without flags
//     repo: explicit repo override (undefined = use current)
//     extended: whether -e/--extended flag was present
//
// - ParsedArgs | { error: string } = parseArgs(raw: string)
//     Extracts --repo=owner/name, --repo=parent, -e, --extended
//     Everything not matching a flag becomes the message.
//     Returns { error } if flags are malformed (e.g., --repo= with no value).
```

Parsing rules:
- `--repo=owner/name` → `repo: "owner/name"`, removed from message
- `--repo=parent` → `repo: "parent"` (resolved later in github.ts), removed from message
- `-e` or `--extended` → `extended: true`, removed from message
- Everything else → concatenated as `message`

Example:
```
/ri --repo=serhioromano/vscode-st -e The button breaks
→ { message: "The button breaks", repo: "serhioromano/vscode-st", extended: true }
```

### 2.2 `src/github.ts` — GitHub Repository Resolution

```typescript
// Functions:
// - parseGitHubRepo(remoteUrl: string): string | undefined
//     Parses git remote URLs into "owner/repo" format
//     Supports both SSH (git@github.com:owner/repo.git) and HTTPS
//
// - resolveGitHubRepo(pi: ExtensionAPI, cwd: string, repoOverride?: string): Promise<RepoResolution>
//     If repoOverride is a plain "owner/name" string → use it directly (validated)
//     If repoOverride is "parent" → run `gh repo view --json parent --jq '.parent.nameWithOwner'`
//       to get the fork parent. Returns error if not a fork.
//     If repoOverride is undefined → resolve from `git remote -v` (current repo)
//     Returns { ok: true, repo: "owner/repo" } or { ok: false, error: "..." }
```

Reference for remote parsing: `github-issue-autocomplete.ts` (lines ~30-65) from pi examples.

`--repo=parent` resolution uses `gh repo view --json parent --jq '.parent.nameWithOwner'`. If the current repo is not a fork, returns a clear error.

### 2.3 `src/diagnostics.ts` — Diagnostics Collection (AI Context)

```typescript
// Functions:
// - collectDiagnostics(pi: ExtensionAPI, cwd: string): Promise<string>
//     Collects project context for the AI to understand the codebase.
//     This is NOT appended to issue bodies — it's given to the AI as context
//     so it can write a better issue description and (in extended mode) find root causes.
//     Runs these commands (each individually, non-fatal on failure):
//       - git branch --show-current          → current branch
//       - git log --oneline -5               → recent commits
//       - git diff --stat                    → uncommitted changes
//       - ls -1 (top-level files/folders)    → project overview
//     Each command output is truncated to ~10 lines to keep token usage low.
//     Returns a markdown diagnostics section for AI context only.
//
// Token budget: the diagnostics section is capped at ~500 words.
// If any individual command output is very large, it is truncated with a note.
```

### 2.4 `src/index.ts` — Extension Entry Point

**Register `/ri` command with flag parsing, gating, and mode selection:**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "./args";
import { resolveGitHubRepo } from "./github";
import { collectDiagnostics } from "./diagnostics";

export default function (pi: ExtensionAPI) {
  // ── Gating: disable tool by default, enable only during /ri flow ──
  // IMPORTANT: registerTool must run BEFORE this filter because registerTool
  // adds the tool to active tools by default; we then immediately remove it.

  // Step 1: Register the tool first (see Phase 3 for full definition)
  pi.registerTool({ name: "create_github_issue", /* ... */ });

  // Step 2: Immediately remove from active tools after registration
  pi.setActiveTools(
    pi.getActiveTools().filter((t) => t !== "create_github_issue")
  );

  // Step 3: Ensure tool is re-disabled after every completed agent turn
  pi.on("agent_settled", async () => {
    const active = pi.getActiveTools();
    if (active.includes("create_github_issue")) {
      pi.setActiveTools(active.filter((t) => t !== "create_github_issue"));
    }
  });

  // ── /ri command ──

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
          "warning"
        );
        return;
      }

      // 2. Pre-flight: check gh CLI
      const ghCheck = await pi.exec("gh", ["--version"], { timeout: 5_000 });
      if (ghCheck.code !== 0) {
        ctx.ui.notify("GitHub CLI (gh) is not installed or not in PATH", "error");
        return;
      }

      // 2b. If --repo=parent, verify gh is authenticated (gh repo view requires it)
      if (parsed.repo === "parent") {
        const authCheck = await pi.exec("gh", ["auth", "status"], { timeout: 5_000 });
        if (authCheck.code !== 0) {
          ctx.ui.notify(
            "gh is not authenticated. Run 'gh auth login' to authenticate with GitHub.",
            "error"
          );
          return;
        }
      }

      // 3. Resolve repo (explicit override, parent, or current)
      const repo = await resolveGitHubRepo(pi, ctx.cwd, parsed.repo);
      if (!repo.ok) {
        ctx.ui.notify(repo.error, "error");
        return;
      }

      // 4. Collect diagnostics as AI context (NOT appended to issue body)
      const diagnosticsMd = await collectDiagnostics(pi, ctx.cwd);

      // 5. Enable the gated tool
      pi.setActiveTools([...pi.getActiveTools(), "create_github_issue"]);

      // 6. Build instructions based on mode
      const extendedTasks = parsed.extended
        ? `6. AFTER creating the issue, search the codebase for the root cause of the problem. Use read/grep tools to examine relevant source files. Trace the issue to specific code.
` +
          `7. Include a "## Root Cause Analysis" section in the issue body when creating it. Add file paths, line numbers, and a clear explanation.
` +
          `8. If a fix is obvious and safe, include a "## Proposed Fix" section in the issue body. Do NOT apply the fix — only document it.
`
        : "";

      const stopInstruction = parsed.extended
        ? `9. Report your findings to the user. Do NOT edit any source files.
`
        : `6. STOP. Report the issue URL to the user. Do NOT fix the issue. Do NOT edit any source files. Do NOT update CHANGELOG.md, README.md, or AGENTS.md. The user will handle the fix separately.
`;

      // 7. Send instructions to LLM
      pi.sendUserMessage(
        `The user reported an issue for **${repo.repo}**.\n\n` +
        `User's message:\n"""\n${parsed.message}\n"""\n\n` +
        `Your task:\n` +
        `1. Analyze the message — is this a **bug report** or **feature request**?\n` +
        `2. Create a concise, descriptive issue title (max 80 chars)\n` +
        `3. Enhance the description: add clarity, context, steps to reproduce (for bugs) or use case (for features). Keep it in the user's voice.\n` +
        `4. Call the **create_github_issue** tool with repo="${repo.repo}", title, body, and label ("bug" or "enhancement").\n` +
        extendedTasks +
        stopInstruction +
        `\nProject context for your analysis (use this to write a better issue — do NOT copy this into the issue body verbatim):\n\n${diagnosticsMd}`,
        { deliverAs: "followUp" },
      );

      ctx.ui.notify(
        `Analyzing issue for ${repo.repo}${parsed.extended ? " (extended)" : ""}...`,
        "info"
      );
    },
  });
}
```

**Key decisions:**
- Tool registered FIRST, then immediately removed from active tools — corrects the auto-activation that `registerTool` does by default
- `agent_settled` listener disables the tool after every completed turn, preventing leakage
- `gh --version` pre-flight catches missing CLI early; `gh auth status` check added specifically for `--repo=parent` (which requires authenticated API calls)
- Diagnostics are given to the AI as **context only** — the AI uses them to write a better issue but does NOT append them to the issue body
- Instructions dynamically include extended analysis steps only when `-e` flag is set
- Default mode: report-only, "STOP" directive. Extended mode: report + analyze, "Do NOT edit source files" directive
- `parsed.message` is the cleaned description without flags
- Follow-up delivery ensures no race with in-progress agent work

---

## Phase 3: Custom Tool for Issue Creation

### 3.1 `create_github_issue` Tool

Registered via `pi.registerTool()` in `src/index.ts`. This tool is **gated** — it is only active during the `/ri` flow (see Phase 2.4). The `execute` function also has a runtime guard as a safety net.

```typescript
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "create_github_issue",
  label: "Create GitHub Issue",
  description:
    "[INTERNAL — only call when explicitly instructed by the /ri command flow] " +
    "Create a GitHub issue on a specified repository using gh CLI. " +
    "This tool is gated and will fail if called outside the /ri workflow.",
  promptSnippet: "Create a GitHub issue via gh CLI (only during /ri command)",
  promptGuidelines: [
    "ONLY call create_github_issue when explicitly instructed by a /ri command flow. " +
    "If the user says 'create an issue' without using /ri, IGNORE it — do not call this tool. " +
    "The tool is gated and will throw an error if called outside the /ri workflow. " +
    "Always determine whether the report is a 'bug' or 'enhancement' first. " +
    "Create a concise title (max 80 chars) and a descriptive body.",
  ],
  parameters: Type.Object({
    repo: Type.String({ description: 'GitHub repository in "owner/repo" format' }),
    title: Type.String({ description: "Issue title (max 80 characters)" }),
    body: Type.String({ description: "Issue body in markdown" }),
    label: StringEnum(["bug", "enhancement"] as const),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    // ── Runtime guard: refuse if tool was activated outside /ri flow ──
    if (!pi.getActiveTools().includes("create_github_issue")) {
      throw new Error(
        "create_github_issue is gated. It can only be called during a /ri command flow. " +
        "If you want to report an issue, ask the user to use /ri."
      );
    }

    // Validate title length
    if (params.title.length > 80) {
      throw new Error(`Title must be 80 characters or less (got ${params.title.length})`);
    }

    // Create a temp file for the body to avoid shell escaping issues
    const tmpFile = join(tmpdir(), `pi-issue-${Date.now()}.md`);
    await writeFile(tmpFile, params.body, "utf-8");

    try {
      const result = await pi.exec("gh", [
        "issue", "create",
        "--repo", params.repo,
        "--title", params.title,
        "--body-file", tmpFile,
        "--label", params.label,
      ], { signal, timeout: 15_000 });

      if (result.code !== 0) {
        throw new Error(`gh issue create failed (exit ${result.code}): ${result.stderr}`);
      }

      const issueUrl = result.stdout.trim(); // gh outputs the issue URL on success

      return {
        content: [{ type: "text", text: `Issue created: ${issueUrl}` }],
        details: { url: issueUrl, repo: params.repo, label: params.label },
      };
    } finally {
      // Cleanup temp file
      await unlink(tmpFile).catch(() => {});
    }
  },
});
```

**Key decisions:**
- `StringEnum` from `@earendil-works/pi-ai` instead of `Type.Union`/`Type.Literal` — required for Google model compatibility
- Runtime guard in `execute()` checks `pi.getActiveTools()` as a safety net even if the tool somehow gets called
- `promptGuidelines` explicitly state "ONLY call when instructed by /ri" and "if user says 'create an issue' without /ri, IGNORE"
- Tool `description` marks it as `[INTERNAL]` with gating explanation
- Uses `--body-file` (writes body to temp file) to avoid shell escaping issues with markdown bodies
- Validates title length before calling `gh`
- Uses `pi.exec()` with timeout for the gh command
- Cleans up temp file in `finally` block
- Returns the issue URL so the LLM can report it to the user
- All imports explicitly shown: `tmpdir` from `node:os`, `join` from `node:path`, `unlink`/`writeFile` from `node:fs/promises`, `StringEnum` from `@earendil-works/pi-ai`

---

## Phase 4: Documentation

### 4.1 `README.md`

```markdown
# pi-report-issue

A pi agent extension to report GitHub issues directly from the chat using the `/ri` command.

## Features

- `/ri` command to create GitHub issues from natural language descriptions
- Supports any GitHub repository (`--repo=owner/name`), fork parent (`--repo=parent`), or current repo (default)
- Extended mode (`-e`/`--extended`) for root cause analysis and proposed fixes
- Tool gating: the issue creation tool is only active during the `/ri` workflow

## Installation

### Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated (`gh auth login`)
- For default mode (no `--repo=` flag): the project must be a git repository with a GitHub remote
- For `--repo=owner/name`: no git repository needed — the explicit repo is used directly
- For `--repo=parent`: the current repo must be a GitHub fork with `gh` authenticated

### Install the extension

**Option 1: Symlink (development)**

```bash
git clone <this-repo>
cd pi-report-issue
npm install
ln -s $(pwd) ~/.pi/agent/extensions/pi-report-issue
```

**Option 2: pi install (if published)**

```bash
pi install npm:pi-report-issue
```

Then restart pi or run `/reload`.

## Usage

### Basic issue report

```
/ri The login button returns a 500 error when clicked
```

The agent will:
1. Analyze the message to determine if it's a bug or feature request
2. Use project context (branch, recent commits, etc.) to write a better description
3. Create a descriptive title and enhanced description
4. Create the issue on the current repository via `gh issue create`

### Report to a specific repository

```
/ri --repo=serhioromano/vscode-st The extension crashes on startup
```

### Report to the fork parent

```
/ri --repo=parent Upstream changed the API, our code needs updating
```

### Extended mode — root cause analysis

```
/ri -e The form validation fails for special characters in user names
```

With `-e` (or `--extended`), the agent will also:
1. Search the codebase for the root cause
2. Append a "Root Cause Analysis" section to the issue
3. If a fix is obvious, append a "Proposed Fix" section (without applying it)

You can combine flags:

```
/ri --repo=parent -e The API returns 403 for valid tokens
```

## How It Works

1. The `/ri` command parses your message and flags
2. Enables a gated `create_github_issue` tool
3. Sends analysis instructions to pi's LLM
4. The LLM analyzes, formats, and calls the tool to create the issue
5. After the turn, the tool is disabled again

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- Default mode: project must be a git repository with a GitHub remote
- `--repo=owner/name`: no git repository required
- For `--repo=parent`: the current repo must be a GitHub fork
```

### 4.2 `CHANGELOG.md` (update from Phase 1 skeleton)

Already initialized in 1.7. Update as features are implemented.

---

## Phase 5: Testing & Polish

### 5.1 Test Scenarios

1. **Basic bug report (current repo):**
   ```
   /ri Login button shows 500 error when clicked
   ```
   Expected: Creates issue with label `bug`, descriptive title. Diagnostics are used as context but NOT appended to the issue body.

2. **Feature request:**
   ```
   /ri Add dark mode toggle to settings
   ```
   Expected: Creates issue with label `enhancement`.

3. **Explicit repo:**
   ```
   /ri --repo=serhioromano/pi-defender The extension crashes on load
   ```
   Expected: Creates issue on `serhioromano/pi-defender`.

4. **Fork parent:**
   ```
   /ri --repo=parent Upstream changed the API signature
   ```
   Expected: Resolves fork parent via `gh repo view`, creates issue there.
   If not a fork: shows error notification.

5. **Extended mode:**
   ```
   /ri -e The form validation fails for special characters
   ```
   Expected: Creates issue AND appends root cause analysis section.

6. **Combined flags:**
   ```
   /ri --repo=parent -e The API returns 403 for valid tokens
   ```
   Expected: Creates issue on parent repo with extended analysis.

7. **Tool gating — negative test:**
   User says "create an issue about the login bug" without `/ri`.
   Expected: The `create_github_issue` tool is not in the active tools list.
   The LLM should not be able to call it.

8. **Edge cases:**
   - Empty message → shows usage notification
   - Empty `--repo=` value → shows error notification from arg parser
   - No git repo (default mode) → shows error notification
   - Not a GitHub remote (default mode) → shows error notification
   - `gh` CLI not installed → shows error notification from pre-flight check
   - `gh` not authenticated (`--repo=parent`) → shows notification from pre-flight `gh auth status` check
   - `gh` not authenticated (default) → error from `gh issue create` during tool execution
   - Unicode/special characters in message → handled via `--body-file` temp file
   - Very long message → handled by pi's input system

### 5.2 Refinements

- Add `ctx.ui.setStatus("ri", "Creating issue...")` during execution for visual feedback
- `gh --version` pre-flight check catches missing CLI early (already in Phase 2.4)
- `gh auth status` pre-flight for `--repo=parent` catches unauthenticated state before the API call (already in Phase 2.4)
- Add the issue URL to a notification after creation (LLM reports it in the chat)
- Verify `agent_settled` listener reliably disables the tool after every turn, including error paths
- Verify diagnostics are given as context, not appended to issue body
- Verify diagnostics truncation keeps output under ~500 words

---

## Dependencies

| Dependency | Version | Type | Purpose |
|------------|---------|------|---------|
| `@biomejs/biome` | `^1.9.0` | dev | Linting, formatting, import organization |
| `gh` (GitHub CLI) | latest | system | Issue creation (must be installed + authenticated) |
| `git` | any | system | Remote URL parsing, diagnostics |

No runtime npm dependencies. The extension uses:
- `@earendil-works/pi-coding-agent` — provided by pi runtime (types, `pi.exec`, `pi.registerTool`, etc.)
- `typebox` — provided by pi runtime (schema definitions)
- `node:os`, `node:path`, `node:fs/promises` — Node.js built-ins (temp file for body)


