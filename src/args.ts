// Argument parser for the /ri command
// Extracts --repo=..., -e/--extended flags from raw user input
// Returns cleaned message and parsed options

export interface ParsedArgs {
	message: string;
	repo?: string;
	extended: boolean;
}

/**
 * Parses flags from the raw /ri command input and returns the cleaned user message.
 *
 * Parsing rules:
 * - `--repo=owner/name` → `repo: "owner/name"`, removed from message
 * - `--repo=parent` → `repo: "parent"` (resolved later in github.ts), removed from message
 * - `-e` or `--extended` → `extended: true`, removed from message
 * - Everything else → concatenated as `message`
 *
 * @returns ParsedArgs or { error } if flags are malformed
 */
export function parseArgs(raw: string): ParsedArgs | { error: string } {
	let message = raw;
	let repo: string | undefined;
	let extended = false;

	// Parse --repo= with possible quoting
	const repoPatterns = [
		// Quoted values: --repo="owner/name" or --repo='owner/name'
		/--repo=(["'])(.*?)\1/,
		// Unquoted values: --repo=owner/name or --repo=parent
		/--repo=([^\s]+)/,
	];

	for (const pattern of repoPatterns) {
		const match = message.match(pattern);
		if (match) {
			const value = match[2] ?? match[1];
			if (!value) {
				return {
					error:
						"--repo= requires a value. Use --repo=owner/name or --repo=parent",
				};
			}
			// Remove quotes if present
			repo = value.replace(/^["']|["']$/g, "");
			message = message.replace(match[0], "");
			break;
		}
	}

	// Parse -e or --extended
	const extendedMatch = message.match(/--extended\b|(?<!\S)-e(?!\S)/);
	if (extendedMatch) {
		extended = true;
		message = message.replace(extendedMatch[0], "");
	}

	// Clean up whitespace
	message = message.trim().replace(/\s{2,}/g, " ");

	return { message, repo, extended };
}
