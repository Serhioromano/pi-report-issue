# Changelog

## [v2.0.1]

### Added
- Duplicate issue detection: subagent now searches for existing similar issues via `gh search issues` before creating a new one (#2)
  - Extracts 3-5 meaningful keywords from the user's message
  - Searches the target repo for open issues matching those keywords
  - If similar issues are found, mentions them as "Possible duplicates: #X, #Y" in the issue body so GitHub auto-interlinks them

### Changed
- `/ri` command now spawns a subagent (separate `pi` process) instead of running inline
  - Main conversation context is no longer consumed by diagnostics and issue-creation instructions
  - User can continue chatting during issue creation; result reported via notification
  - Complex `agent_settled` gating removed in favor of `PI_REPORT_ISSUE_SUBAGENT` env var check

### Added
- `src/subagent.ts` — subagent spawning infrastructure for isolated `/ri` execution
  - Spawns `pi --mode json -p --no-session` subprocess with `PI_REPORT_ISSUE_SUBAGENT` env var
  - Parses JSON mode stdout to extract issue URLs from tool results
  - Supports AbortSignal propagation for cancellation
  - Auto-resolves pi binary path and extension path for dev and global install scenarios

## [v1.0.0]

### Added
- `/ri` command to report GitHub issues from the chat
- `create_github_issue` gated tool for issue creation via `gh` CLI
- Support for `--repo=<owner/name>` and `--repo=parent` flags
- Extended mode (`-e`/`--extended`) for root cause analysis
- Diagnostics collection (branch, recent commits, uncommitted changes, project overview)
