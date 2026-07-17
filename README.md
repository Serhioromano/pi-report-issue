# PI Agent Issue Reporter

A pi agent extension to accept a short issue message, enhance it with AI and report GitHub issues directly from the chat using the `/ri` command.

![Logo](https://raw.githubusercontent.com/Serhioromano/pi-report-issue/refs/heads/main/icon.png)

## Features

- `/ri` command to create GitHub issues from natural language descriptions
- **Subagent isolation** — issue creation runs in a separate `pi` process, preserving your main conversation context
- **Non-blocking** — continue chatting while the subagent creates the issue in the background; result appears as a notification
- Supports any GitHub repository (`--repo=owner/name`), fork parent (`--repo=parent`), or current repo (default)
- **Repo-aware** — auto-detects issue templates (`.github/ISSUE_TEMPLATE/`, `CONTRIBUTING.md`) and tailors the issue body to match each repository's guidelines
- Extended mode (`-e`/`--extended`) for root cause analysis and proposed fixes
- Tool gating: the `create_github_issue` tool is only available in the subagent, never in the main session

## Installation

### Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated (`gh auth login`)
- For default mode (no `--repo=` flag): the project must be a git repository with a GitHub remote
- For `--repo=owner/name`: no git repository needed — the explicit repo is used directly
- For `--repo=parent`: the current repo must be a GitHub fork with `gh` authenticated

### Install the extension

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
3. Search for existing similar issues and mention them as "Possible duplicates: #X, #Y" so GitHub interlinks them
4. Create a descriptive title and enhanced description
5. Create the issue on the current repository via `gh issue create`

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
2. Resolves the target GitHub repository and collects project context
3. Spawns a **subagent** — a separate `pi` process with an isolated context window
4. **Fetches the target repo's issue guidelines** (`.github/ISSUE_TEMPLATE/`, `.github/ISSUE_TEMPLATE.md`, `CONTRIBUTING.md`) via the GitHub API so the issue body follows the maintainers' expected format
5. The subagent's LLM analyzes your message, extracts keywords, and searches for existing similar issues via `gh search issues`
6. If similar issues are found, they are mentioned as "Possible duplicates" in the new issue body — GitHub auto-interlinks them
7. The subagent formats the issue (following any detected templates) and calls the `create_github_issue` tool
8. The issue URL is shown as a notification — while you keep working

A **subagent status widget** is pinned at the bottom of the UI during the entire process, showing live status: "Subagent started", "Subagent completed", or "Subagent failed". It auto-dismisses after 5 seconds.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- Default mode: project must be a git repository with a GitHub remote
- `--repo=owner/name`: no git repository required
- For `--repo=parent`: the current repo must be a GitHub fork
