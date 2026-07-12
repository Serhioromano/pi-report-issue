// Diagnostics collector for the /ri command
// Gathers project context (branch, commits, changes, structure)
// Given to the AI as context — NOT appended to issue bodies

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Maximum lines to keep from a single command output. */
const MAX_LINES = 10;

/**
 * Truncates multi-line output to ~maxLines.
 * Appends a note if truncation occurred.
 */
function truncate(output: string, maxLines: number): string {
	const lines = output.split("\n");
	if (lines.length <= maxLines) {
		return output;
	}
	const kept = lines.slice(0, maxLines);
	return `${kept.join("\n")}\n... (truncated, ${lines.length} lines total)`;
}

/**
 * Runs a command and returns its output, or a fallback message on failure.
 * Output is truncated to MAX_LINES.
 */
async function runDiagnostic(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	args: string[],
): Promise<string> {
	try {
		const result = await pi.exec(command, args, {
			cwd,
			timeout: 5_000,
		});
		if (result.code !== 0) {
			return `(command failed: ${result.stderr.trim() || `exit ${result.code}`})`;
		}
		return truncate(result.stdout.trim(), MAX_LINES);
	} catch {
		return "(command timed out or could not run)";
	}
}

/**
 * Lists top-level files and folders in a directory.
 * Truncated to MAX_LINES.
 */
async function listTopLevel(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("ls", ["-1"], { cwd, timeout: 5_000 });
		if (result.code !== 0) {
			return "(could not list directory)";
		}
		return truncate(result.stdout.trim(), MAX_LINES);
	} catch {
		return "(could not list directory)";
	}
}

/**
 * Collects project context for the AI to understand the codebase.
 *
 * This is NOT appended to issue bodies — it's given to the AI as context
 * so it can write a better issue description and (in extended mode) find root causes.
 *
 * Runs these commands (each individually, non-fatal on failure):
 *   - git branch --show-current          → current branch
 *   - git log --oneline -5               → recent commits
 *   - git diff --stat                    → uncommitted changes
 *   - ls -1 (top-level files/folders)    → project overview
 *
 * Each command output is truncated to ~10 lines to keep token usage low.
 * Token budget: the diagnostics section is capped at ~500 words.
 */
export async function collectDiagnostics(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string> {
	const [branch, recentCommits, uncommittedChanges, projectFiles] =
		await Promise.all([
			runDiagnostic(pi, cwd, "git", ["branch", "--show-current"]),
			runDiagnostic(pi, cwd, "git", ["log", "--oneline", "-5"]),
			runDiagnostic(pi, cwd, "git", ["diff", "--stat"]),
			listTopLevel(pi, cwd),
		]);

	const sections: string[] = [];

	if (branch && branch !== "(command failed:") {
		sections.push(`**Current branch:** ${branch}`);
	}

	if (recentCommits && recentCommits !== "(command failed:") {
		sections.push(`**Recent commits:**\n\`\`\`\n${recentCommits}\n\`\`\``);
	}

	if (
		uncommittedChanges &&
		uncommittedChanges !== "(command failed:" &&
		uncommittedChanges.trim()
	) {
		sections.push(
			`**Uncommitted changes:**\n\`\`\`\n${uncommittedChanges}\n\`\`\``,
		);
	}

	if (projectFiles && projectFiles !== "(could not list directory)") {
		sections.push(
			`**Project files (top-level):**\n\`\`\`\n${projectFiles}\n\`\`\``,
		);
	}

	return sections.join("\n\n");
}
