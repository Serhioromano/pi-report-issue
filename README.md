# PI Agent Issue Reporter

A pi agent extension to accept a short issue message, enhance it with AI and report GitHub issues directly from the chat using the `/ri` command.

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
