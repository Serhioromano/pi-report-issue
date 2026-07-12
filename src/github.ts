// GitHub repository resolution for the /ri command
// Resolves target repo from: explicit --repo=, --repo=parent, or git remote

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RepoResolution =
	| { ok: true; repo: string }
	| { ok: false; error: string };

/**
 * Parses a git remote URL into "owner/repo" format.
 * Supports both SSH (git@github.com:owner/repo.git) and HTTPS formats.
 */
export function parseGitHubRepo(remoteUrl: string): string | undefined {
	const sshMatch = remoteUrl.match(
		/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
	);
	if (sshMatch) {
		return sshMatch[1];
	}

	const httpsMatch = remoteUrl.match(
		/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
	);
	if (httpsMatch) {
		return httpsMatch[1];
	}

	return undefined;
}

/**
 * Replaces "parent" repo override with the actual fork parent.
 * Uses `gh repo view --json parent --jq '.parent.nameWithOwner'`.
 */
async function resolveParentRepo(
	pi: ExtensionAPI,
	cwd: string,
): Promise<RepoResolution> {
	const result = await pi.exec(
		"gh",
		["repo", "view", "--json", "parent", "--jq", ".parent.nameWithOwner"],
		{ cwd, timeout: 5_000 },
	);

	if (result.code !== 0 || !result.stdout.trim()) {
		return {
			ok: false,
			error:
				"Could not determine fork parent. Make sure this repo is a GitHub fork and gh CLI is authenticated.",
		};
	}

	return { ok: true, repo: result.stdout.trim() };
}

/**
 * Validates a user-supplied "owner/name" string format.
 */
function isValidRepoFormat(repo: string): boolean {
	return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo);
}

/**
 * Resolves the target GitHub repository for issue creation.
 *
 * - If repoOverride is a plain "owner/name" string, use it directly (validated format).
 * - If repoOverride is "parent", resolve the fork parent via `gh repo view`.
 * - If repoOverride is undefined, resolve from `git remote -v` (current repo).
 *
 * @returns { ok: true, repo: "owner/repo" } or { ok: false, error: "..." }
 */
export async function resolveGitHubRepo(
	pi: ExtensionAPI,
	cwd: string,
	repoOverride?: string,
): Promise<RepoResolution> {
	// Case 1: Explicit "owner/name" override
	if (repoOverride && repoOverride !== "parent") {
		if (!isValidRepoFormat(repoOverride)) {
			return {
				ok: false,
				error: `Invalid --repo= format: "${repoOverride}". Use --repo=owner/name or --repo=parent.`,
			};
		}
		return { ok: true, repo: repoOverride };
	}

	// Case 2: Fork parent
	if (repoOverride === "parent") {
		return resolveParentRepo(pi, cwd);
	}

	// Case 3: Current repo from git remote
	const result = await pi.exec("git", ["remote", "-v"], {
		cwd,
		timeout: 5_000,
	});
	if (result.code !== 0) {
		return {
			ok: false,
			error:
				"Current directory is not a git repository. Use --repo=owner/name to specify a target repository.",
		};
	}

	for (const line of result.stdout.split("\n")) {
		const columns = line.trim().split(/\s+/);
		const remoteUrl = columns[1];
		if (!remoteUrl) continue;
		const repo = parseGitHubRepo(remoteUrl);
		if (repo) {
			return { ok: true, repo };
		}
	}

	return {
		ok: false,
		error:
			"No GitHub remote found in current repository. Use --repo=owner/name to specify a target repository.",
	};
}
