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
			// ── Runtime guard: refuse if tool was activated outside /ri flow ──
			if (!pi.getActiveTools().includes("create_github_issue")) {
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

	// Step 2: Disable tool by default once the runtime is ready, and set up
	// agent_settled listener to re-disable after every completed turn.
	// setActiveTools/getActiveTools are "action methods" — they cannot be
	// called synchronously during extension factory execution.
	pi.on("session_start", () => {
		pi.setActiveTools(
			pi.getActiveTools().filter((t) => t !== "create_github_issue"),
		);
	});

	pi.on("agent_settled", async () => {
		const active = pi.getActiveTools();
		if (active.includes("create_github_issue")) {
			pi.setActiveTools(active.filter((t) => t !== "create_github_issue"));
		}
	});

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

			// 5. Enable the gated tool for this turn
			pi.setActiveTools([...pi.getActiveTools(), "create_github_issue"]);

			// 6. Build instructions based on mode
			const extendedTasks = parsed.extended
				? "6. AFTER creating the issue, search the codebase for the root cause of the problem. Use read/grep tools to examine relevant source files. Trace the issue to specific code.\n" +
					'7. Include a "## Root Cause Analysis" section in the issue body when creating it. Add file paths, line numbers, and a clear explanation.\n' +
					'8. If a fix is obvious and safe, include a "## Proposed Fix" section in the issue body. Do NOT apply the fix — only document it.\n'
				: "";

			const stopInstruction = parsed.extended
				? "9. Report your findings to the user. Do NOT edit any source files.\n"
				: "6. STOP. Report the issue URL to the user. Do NOT fix the issue. Do NOT edit any source files. Do NOT update CHANGELOG.md, README.md, or AGENTS.md. The user will handle the fix separately.\n";

			// 7. Send instructions to LLM
			pi.sendUserMessage(
				`The user reported an issue for **${repo.repo}**.\n\nUser's message:\n"""\n${parsed.message}\n"""\n\nYour task:\n1. Analyze the message — is this a **bug report** or **feature request**?\n2. Create a concise, descriptive issue title (max 80 chars)\n3. Enhance the description: add clarity, context, steps to reproduce (for bugs) or use case (for features). Keep it in the user's voice.\n4. Call the **create_github_issue** tool with repo="${repo.repo}", title, body, and label ("bug" or "enhancement").\n${extendedTasks}${stopInstruction}\nProject context for your analysis (use this to write a better issue — do NOT copy this into the issue body verbatim):\n\n${diagnosticsMd}`,
				{ deliverAs: "followUp" },
			);

			ctx.ui.notify(
				`Analyzing issue for ${repo.repo}${parsed.extended ? " (extended)" : ""}...`,
				"info",
			);
		},
	});
}
