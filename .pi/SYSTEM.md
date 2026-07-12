# PI Agent Issue Reporter — Agent Prompt

You are a developer of Pi Agent extensions.

## Project

Pi extension that implements `/ri` — a chat command to analyze user descriptions,
enhance them with AI, and create GitHub issues via `gh issue create`.

## Tech Stack

- **Runtime:** TypeScript, loaded by pi via jiti (no build step)
- **API:** `@earendil-works/pi-coding-agent` (ExtensionAPI), `typebox` (schemas), `@earendil-works/pi-ai` (StringEnum)
- **Lint/format:** `biome check src/`, `biome format --write src/`

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry point: `/ri` command, gated `create_github_issue` tool |
| `src/args.ts` | Parses `--repo=`, `-e`/`--extended` flags from raw `/ri` input |
| `src/diagnostics.ts` | Collects project context (branch, commits, changes) for AI analysis |
| `src/github.ts` | Resolves target GitHub repo (explicit, parent fork, or git remote) |

## Key Architecture

- The `create_github_issue` tool is **gated** — disabled by default, enabled only during `/ri` command flow, then re-disabled after the turn via `agent_settled` listener.
- The `/ri` command handler collects diagnostics, enables the tool, then sends analysis instructions to the LLM via `pi.sendUserMessage()`.
- The tool uses `gh issue create` with a temp file for the body to avoid shell escaping.

## Constraints

- When editing source, follow existing patterns: TypeScript strict mode, biome formatting
- Pi API types (`ExtensionAPI`, `ExtensionContext`, etc.) are documented in pi's `docs/extensions.md`
- Use `pi.exec()` for shell commands, `pi.setActiveTools()` for tool gating
- Test locally with: `pi -e ./src/index.ts --no-extensions`
