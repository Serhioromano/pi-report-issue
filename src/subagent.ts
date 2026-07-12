// Subagent spawner for the /ri command
// Spawns a separate pi process to create GitHub issues in an isolated context,
// preserving the main conversation context window.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SubagentResult {
	success: boolean;
	issueUrl?: string;
	error?: string;
	rawOutput?: string;
}

/**
 * Spawns a pi subprocess to create a GitHub issue.
 *
 * The subprocess runs in JSON mode (--mode json -p --no-session) for one-shot
 * execution: it receives the task, the LLM analyzes it, calls
 * create_github_issue, and exits. Output is parsed from stdout JSON lines.
 *
 * The PI_REPORT_ISSUE_SUBAGENT env var signals the extension to keep the tool
 * active (no gating needed in subagent context).
 *
 * @param cwd - Working directory for the subprocess
 * @param task - One-shot task with diagnostics and instructions
 * @param signal - AbortSignal for cancellation
 * @returns Parsed result with issue URL or error
 */
export async function spawnIssueSubagent(
	cwd: string,
	task: string,
	signal?: AbortSignal,
): Promise<SubagentResult> {
	const piInvocation = resolvePiInvocation();
	const extensionPath = resolveExtensionPath();

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"-e",
		extensionPath,
		"--tools",
		"create_github_issue",
		task,
	];

	const env = { ...process.env, PI_REPORT_ISSUE_SUBAGENT: "true" };

	return new Promise((resolve) => {
		const proc = spawn(piInvocation.command, piInvocation.args.concat(args), {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});

		const messages: JsonMessage[] = [];
		let buffer = "";
		let stderr = "";
		let lastAssistantText = "";

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as JsonEvent;
					processEvent(event, messages, (text) => {
						lastAssistantText = text;
					});
				} catch {
					// Ignore unparseable lines (partial writes, non-JSON output)
				}
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			// Flush remaining buffer
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer.trim()) as JsonEvent;
					processEvent(event, messages, (text) => {
						lastAssistantText = text;
					});
				} catch {
					/* ignore */
				}
			}

			if (code !== 0) {
				resolve({
					success: false,
					error: stderr.trim() || `Subprocess exited with code ${code}`,
					rawOutput: lastAssistantText || undefined,
				});
				return;
			}

			const issueUrl = extractIssueUrl(messages, lastAssistantText);

			if (issueUrl) {
				resolve({
					success: true,
					issueUrl,
					rawOutput: lastAssistantText || undefined,
				});
			} else {
				resolve({
					success: false,
					error: "No issue URL found in subagent output",
					rawOutput: lastAssistantText || stderr.trim() || undefined,
				});
			}
		});

		proc.on("error", (err) => {
			resolve({
				success: false,
				error: `Failed to spawn subagent: ${err.message}`,
			});
		});

		// Propagate abort signal to subprocess
		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) {
				kill();
			} else {
				signal.addEventListener("abort", kill, { once: true });
			}
		}
	});
}

// ── Internal types for JSON mode event parsing ──

interface JsonEvent {
	type: string;
	message?: JsonMessage;
}

interface JsonMessage {
	role: string;
	content: JsonContentPart[];
}

type JsonContentPart =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> }
	| { type: "toolResult"; toolCallId: string; content: unknown };

/** Processes a single JSON event, extracting assistant text and storing messages. */
function processEvent(
	event: JsonEvent,
	messages: JsonMessage[],
	onAssistantText: (text: string) => void,
): void {
	if (
		(event.type === "message_end" || event.type === "tool_result_end") &&
		event.message
	) {
		messages.push(event.message);

		if (event.message.role === "assistant") {
			for (const part of event.message.content) {
				if (part.type === "text") {
					onAssistantText(part.text);
				}
			}
		}
	}
}

/**
 * Extracts the GitHub issue URL from subagent output.
 *
 * Searches through all messages for issue URLs, checking:
 * 1. Tool result content from create_github_issue (structured)
 * 2. Assistant text messages (fallback)
 *
 * Matches URLs like https://github.com/owner/repo/issues/123
 */
function extractIssueUrl(
	messages: JsonMessage[],
	fallbackText: string,
): string | undefined {
	const urlPattern =
		/https?:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/issues\/\d+/;

	// Check all messages for issue URLs in text content
	for (const msg of messages) {
		const text = getMessageText(msg);
		const match = text.match(urlPattern);
		if (match) return match[0];
	}

	// Fallback: parse from last assistant text
	const match = fallbackText.match(urlPattern);
	return match?.[0];
}

/** Recursively extracts all text from a message's content parts. */
function getMessageText(msg: JsonMessage): string {
	const parts: string[] = [];

	for (const part of msg.content) {
		if (part.type === "text") {
			parts.push(part.text);
		} else if (part.type === "toolResult" && part.content) {
			// Tool result content can be an array of content blocks or a single block
			const blocks = Array.isArray(part.content)
				? part.content
				: [part.content];
			for (const block of blocks) {
				if (typeof block === "object" && block !== null && "text" in block) {
					parts.push((block as { text: string }).text);
				}
			}
		}
	}

	return parts.join("\n");
}

// ── Path resolution ──

/** Resolves the pi binary and its base arguments. */
function resolvePiInvocation(): { command: string; args: string[] } {
	const scriptPath = process.argv[1];

	// If argv[1] is a real script file, use `node <script>` invocation.
	// This handles development scenarios where pi is run via node.
	if (scriptPath && existsSync(scriptPath)) {
		return { command: process.execPath, args: [scriptPath] };
	}

	// Otherwise, assume `pi` is available in PATH (e.g., global install).
	return { command: "pi", args: [] };
}

/** Resolves the path to this extension's entry point (src/index.ts). */
function resolveExtensionPath(): string {
	const currentFile = fileURLToPath(import.meta.url);
	const srcDir = dirname(currentFile);
	return join(srcDir, "index.ts");
}
