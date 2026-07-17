// Pi Report Issue Extension — entry point
// Registered as a pi extension via package.json → pi.extensions
// Implements the /ri command and gated create_github_issue tool

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseArgs } from "./args";
import { collectDiagnostics } from "./diagnostics";
import { resolveGitHubRepo } from "./github";
import { fetchIssueGuidelines } from "./guidelines";
import { spawnIssueSubagent } from "./subagent";

/** Draws a Unicode box around lines for the subagent status widget. */
function framedWidget(lines: string[], minWidth = 50): string[] {
	const innerMax = Math.max(minWidth, ...lines.map((l) => l.length));
	const width = Math.min(innerMax + 4, 80); // +4 for "│ " + " │" padding
	const bar = "─".repeat(width - 2);
	const framed = lines.map((line) => {
		const pad = width - 4 - line.length;
		return `│ ${line}${pad > 0 ? " ".repeat(pad) : ""} │`;
	});
	return [`┌${bar}┐`, ...framed, `└${bar}┘`];
}

export default function (pi: ExtensionAPI) {
	// ── Gating: disable tool by default, enable only during /ri flow ──
	// IMPORTANT: registerTool must run BEFORE this filter because registerTool
	// adds the tool to active tools by default; we then immediately remove it.

	// Step 1: Register the gated create_github_issue tool
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
			repo: Type.String({
				description: 'GitHub repository in "owner/repo" format',
			}),
			title: Type.String({
				description: "Issue title (max 80 characters)",
			}),
			body: Type.String({
				description: "Issue body in markdown",
			}),
			label: StringEnum(["bug", "enhancement"] as const),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			// ── Runtime guard: only allow in subagent context ──
			if (!process.env.PI_REPORT_ISSUE_SUBAGENT) {
				throw new Error(
					"create_github_issue is gated. It can only be called during a /ri command flow. " +
						"If you want to report an issue, ask the user to use /ri.",
				);
			}

			// Validate title length
			if (params.title.length > 80) {
				throw new Error(
					`Title must be 80 characters or less (got ${params.title.length})`,
				);
			}

			// Create a temp file for the body to avoid shell escaping issues
			const tmpFile = join(tmpdir(), `pi-issue-${Date.now()}.md`);
			await writeFile(tmpFile, params.body, "utf-8");

			try {
				const result = await pi.exec(
					"gh",
					[
						"issue",
						"create",
						"--repo",
						params.repo,
						"--title",
						params.title,
						"--body-file",
						tmpFile,
						"--label",
						params.label,
					],
					{ signal, timeout: 15_000 },
				);

				if (result.code !== 0) {
					throw new Error(
						`gh issue create failed (exit ${result.code}): ${result.stderr}`,
					);
				}

				const issueUrl = result.stdout.trim();

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

	// Step 2: Gate the tool — in the main process, never enable it.
	// In the subagent (PI_REPORT_ISSUE_SUBAGENT=true), it stays active
	// because the LLM in the isolated context is explicitly instructed to use it.
	// setActiveTools/getActiveTools are "action methods" — they cannot be
	// called synchronously during extension factory execution.
	if (!process.env.PI_REPORT_ISSUE_SUBAGENT) {
		pi.on("session_start", () => {
			pi.setActiveTools(
				pi.getActiveTools().filter((t) => t !== "create_github_issue"),
			);
		});
	}

	// ── /ri command ──

	pi.registerCommand("ri", {
		description:
			"Report a GitHub issue. Usage: /ri [-e] [--repo=owner/name|parent] <description>",
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

			// 2. Pre-flight: check gh CLI is installed
			const ghCheck = await pi.exec("gh", ["--version"], {
				timeout: 5_000,
			});
			if (ghCheck.code !== 0) {
				ctx.ui.notify(
					"GitHub CLI (gh) is not installed or not in PATH.",
					"error",
				);
				return;
			}

			// 2b. If --repo=parent, verify gh is authenticated (gh repo view requires it)
			if (parsed.repo === "parent") {
				const authCheck = await pi.exec("gh", ["auth", "status"], {
					timeout: 5_000,
				});
				if (authCheck.code !== 0) {
					ctx.ui.notify(
						"gh is not authenticated. Run 'gh auth login' to authenticate with GitHub.",
						"error",
					);
					return;
				}
			}

			// 3. Resolve target repo (explicit override, parent, or current)
			const repo = await resolveGitHubRepo(pi, ctx.cwd, parsed.repo);
			if (!repo.ok) {
				ctx.ui.notify(repo.error, "error");
				return;
			}

			// 4. Collect diagnostics as AI context (NOT appended to issue body)
			const diagnosticsMd = await collectDiagnostics(pi, ctx.cwd);

			// 4.5. Fetch repo-specific issue guidelines (templates, CONTRIBUTING.md)
			const guidelinesMd = await fetchIssueGuidelines(pi, repo.repo);

			// 5. Build the task for the subagent
			const duplicateCheckStep = [
				"4. BEFORE creating the issue, search the target repo for existing similar issues:",
				"   a. Extract 3-5 meaningful keywords from the user's message (NOT generic words like 'error', 'bug', 'fix').",
				`   b. Run: gh search issues "KEYWORDS" --repo=${repo.repo} --state=open --limit=10 --json number,title,url`,
				"   c. If any existing issues describe the SAME problem or feature, include a line at the top of the issue body:",
				"      > Possible duplicates: #123, #456",
				"      (use the issue numbers from the search results — GitHub will auto-link them).",
				"   d. Always proceed to step 5 and create the issue.",
			].join("\n");

			const extendedTasks = parsed.extended
				? "7. AFTER creating the issue, search the codebase for the root cause of the problem. Use read/grep tools to examine relevant source files. Trace the issue to specific code.\n" +
					'8. Include a "## Root Cause Analysis" section in the issue body when creating it. Add file paths, line numbers, and a clear explanation.\n' +
					'9. If a fix is obvious and safe, include a "## Proposed Fix" section in the issue body. Do NOT apply the fix — only document it.\n'
				: "";

			const stopInstruction = parsed.extended
				? "10. Report your findings to the user. Do NOT edit any source files.\n"
				: "7. STOP. Report the issue URL to the user. Do NOT fix the issue. Do NOT edit any source files. Do NOT update CHANGELOG.md, README.md, or AGENTS.md. The user will handle the fix separately.\n";

			const guidelinesBlock = guidelinesMd ? [guidelinesMd, "", "---", ""] : [];

			const task = [
				`The user reported an issue for **${repo.repo}**.`,
				"",
				"User's message:",
				'<message>',
				parsed.message,
				'</message>',
				"",
				...guidelinesBlock,
				"Your task:",
				"1. Analyze the message — is this a **bug report** or **feature request**?",
				"2. Create a concise, descriptive issue title (max 80 chars)",
				"3. Enhance the description: add clarity, context, steps to reproduce (for bugs) or use case (for features). Keep it in the user's voice.",
				"3b. If repo guidelines were provided above, follow their structure — use the same section headings and required fields.",
				duplicateCheckStep,
				`5. Call the **create_github_issue** tool with repo="${repo.repo}", title, body, and label ("bug" or "enhancement").`,
				extendedTasks,
				stopInstruction,
				"Project context for your analysis (use this to write a better issue — do NOT copy this into the issue body verbatim):",
				"",
				diagnosticsMd,
			]
				.join("\n")
				.trim();

			// 6. Show subagent status widget + notify, then spawn subagent (fire-and-forget)
			const subagentLabel = `Creating issue on ${repo.repo}${parsed.extended ? " (extended)" : ""}`;

			ctx.ui.setWidget(
				"ri-subagent-status",
				framedWidget(["... Subagent: Initializing..."]),
				{ placement: "belowEditor" },
			);
			ctx.ui.notify(subagentLabel, "info");

			spawnIssueSubagent(ctx.cwd, task, undefined, (stage) => {
				const stageLabels: Record<string, string> = {
					analyzing: "... Analyzing request...",
					searching: "... Searching for duplicates...",
					creating: "... Creating issue...",
				};
				const label = stageLabels[stage] || stage;
				ctx.ui.setWidget(
					"ri-subagent-status",
					framedWidget([`Subagent: ${label}`]),
					{ placement: "belowEditor" },
				);
			}).then((result) => {
				if (result.success && result.issueUrl) {
					ctx.ui.setWidget(
						"ri-subagent-status",
						framedWidget(["[OK] Issue created", result.issueUrl]),
						{ placement: "belowEditor" },
					);
					ctx.ui.notify(`Issue created: ${result.issueUrl}`, "success");
				} else {
					const errMsg = result.error || "Unknown error";
					ctx.ui.setWidget(
						"ri-subagent-status",
						framedWidget(["[FAIL] Failed", errMsg]),
						{ placement: "belowEditor" },
					);
					ctx.ui.notify(`Failed to create issue: ${errMsg}`, "error");
				}

				// Auto-dismiss widget after 5 seconds
				setTimeout(() => {
					ctx.ui.setWidget("ri-subagent-status", undefined);
				}, 5000);
			});
		},
	});
}
