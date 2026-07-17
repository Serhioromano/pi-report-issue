// Issue guidelines fetcher for the /ri command
// Fetches repo-specific issue templates and contributing guidelines
// from the target GitHub repository via gh api, then passes them
// to the subagent so it can tailor the issue body to match what
// the maintainers expect.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Template file extensions we care about. */
const TEMPLATE_EXTS = /\.(ya?ml|md)$/;

/**
 * Fetches issue guidelines from the target GitHub repository.
 *
 * Checks these locations (in order):
 *   1. `.github/ISSUE_TEMPLATE/` directory — fetches all .yml/.yaml/.md files
 *   2. `.github/ISSUE_TEMPLATE.md` — legacy single template
 *   3. `CONTRIBUTING.md` — often contains issue reporting instructions
 *
 * Each file's content is fetched, base64-decoded, and assembled into
 * a Markdown section for the subagent prompt.
 *
 * @returns Markdown string with guidelines, or empty string if none found.
 *          Never throws — all errors are silently caught so missing
 *          guidelines never break the /ri flow.
 */
export async function fetchIssueGuidelines(
	pi: ExtensionAPI,
	repo: string,
): Promise<string> {
	const sections: string[] = [];

	// 1. Check for .github/ISSUE_TEMPLATE/ directory
	const templateFiles = await fetchTemplateDirectory(pi, repo);
	for (const file of templateFiles) {
		if (!TEMPLATE_EXTS.test(file)) continue;
		const content = await fetchFileContent(
			pi,
			repo,
			`.github/ISSUE_TEMPLATE/${file}`,
		);
		if (content) {
			sections.push(`### Template: \`${file}\`\n\n${content}`);
		}
	}

	// 2. Check for .github/ISSUE_TEMPLATE.md (legacy single template)
	const legacyTemplate = await fetchFileContent(
		pi,
		repo,
		".github/ISSUE_TEMPLATE.md",
	);
	if (legacyTemplate) {
		sections.push(`### \`.github/ISSUE_TEMPLATE.md\`\n\n${legacyTemplate}`);
	}

	// 3. Check for CONTRIBUTING.md
	const contributing = await fetchFileContent(pi, repo, "CONTRIBUTING.md");
	if (contributing) {
		sections.push(`### \`CONTRIBUTING.md\`\n\n${contributing}`);
	}

	if (sections.length === 0) return "";

	return [
		"## Repository Issue Guidelines",
		"",
		`The target repository (**${repo}**) provides the following issue guidelines.`,
		"**Follow this structure when creating the issue body.**",
		"Use the same section headings, checklists, and required fields that the templates specify.",
		"",
		...sections,
	].join("\n");
}

// ── Helpers ──

/**
 * Lists filenames in `.github/ISSUE_TEMPLATE/` directory via GitHub API.
 * Returns an empty array on any error (404 = no templates, etc.).
 */
async function fetchTemplateDirectory(
	pi: ExtensionAPI,
	repo: string,
): Promise<string[]> {
	try {
		const result = await pi.exec(
			"gh",
			[
				"api",
				`repos/${repo}/contents/.github/ISSUE_TEMPLATE`,
				"--jq",
				".[].name",
			],
			{ timeout: 10_000 },
		);

		if (result.code !== 0 || !result.stdout.trim()) return [];
		return result.stdout.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Fetches a single file's content from the GitHub API (base64-encoded)
 * and returns the decoded UTF-8 string.
 * Returns undefined on any error.
 */
async function fetchFileContent(
	pi: ExtensionAPI,
	repo: string,
	path: string,
): Promise<string | undefined> {
	try {
		const result = await pi.exec(
			"gh",
			["api", `repos/${repo}/contents/${path}`, "--jq", ".content"],
			{ timeout: 10_000 },
		);

		if (result.code !== 0 || !result.stdout.trim()) return undefined;

		// GitHub API returns file contents base64-encoded
		return Buffer.from(result.stdout.trim(), "base64").toString("utf-8");
	} catch {
		return undefined;
	}
}
