import * as levenshtein from "fast-levenshtein";
import type { Context } from "probot";
import type { Config } from "../config.js";

export async function handleSpamCheck(
	context: Context,
	config: Config,
): Promise<boolean> {
	if (!config.spam.enabled) return false;

	const { payload } = context;
	const isIssue = "issue" in payload;
	const isPR = "pull_request" in payload;
	const isComment = "comment" in payload;

	let body = "";
	let title = "";
	let author = "";
	let created_at = "";

	if (isComment) {
		const commentPayload = payload as typeof payload & {
			comment: { body: string; user: { login: string; created_at: string } };
		};
		body = commentPayload.comment.body || "";
		author = commentPayload.comment.user.login;
		created_at = commentPayload.comment.user.created_at;
	} else if (isIssue || isPR) {
		const itemPayload = (isPR ? payload.pull_request : payload.issue) as {
			body: string;
			title: string;
			user: { login: string };
		};
		body = itemPayload.body || "";
		title = itemPayload.title || "";
		author = itemPayload.user.login;
		created_at = await getUserCreatedAt(context, author);
	}

	// 1. Account Age Check
	const accountAge = getAccountAgeDays(created_at);
	if (accountAge < config.spam.minAccountAgeDays) {
		await markAsSpam(context, "Account is too new.", config.dryRun);
		return true;
	}

	// 2. Keyword Check
	if (
		containsKeywords(title, config.spam.keywords) ||
		containsKeywords(body, config.spam.keywords)
	) {
		await markAsSpam(context, "Content contains spam keywords.", config.dryRun);
		return true;
	}

	// 3. Link Count Check
	if (countLinks(body) > config.spam.maxLinks) {
		await markAsSpam(context, "Too many links in content.", config.dryRun);
		return true;
	}

	// 4. Template Similarity Check (Only for new Issues/PRs)
	if (
		(isIssue || isPR) &&
		!isComment &&
		context.name === "issues" &&
		"action" in context.payload &&
		context.payload.action === "opened"
	) {
		// Only check on open, not edit (to save API calls and complexity)
		const isSpamTemplate = await checkTemplateSimilarity(
			context,
			body,
			isPR,
			config.spam.maxTemplateSimilarity,
		);
		if (isSpamTemplate) {
			await markAsSpam(
				context,
				"Content is too similar to the template (did you fill it out?).",
				config.dryRun,
			);
			return true;
		}
	}

	if (
		(isIssue || isPR) &&
		!isComment &&
		context.name === "pull_request" &&
		"action" in context.payload &&
		context.payload.action === "opened"
	) {
		const isSpamTemplate = await checkTemplateSimilarity(
			context,
			body,
			isPR,
			config.spam.maxTemplateSimilarity,
		);
		if (isSpamTemplate) {
			await markAsSpam(
				context,
				"Content is too similar to the template (did you fill it out?).",
				config.dryRun,
			);
			return true;
		}
	}

	return false;
}

async function getUserCreatedAt(
	context: Context,
	username: string,
): Promise<string> {
	// Try to get from payload first if available
	if (
		"sender" in context.payload &&
		context.payload.sender &&
		context.payload.sender.login === username &&
		"created_at" in context.payload.sender &&
		typeof context.payload.sender.created_at === "string"
	) {
		return context.payload.sender.created_at;
	}

	try {
		const { data: user } = await context.octokit.users.getByUsername({
			username,
		});
		return user.created_at;
	} catch (e) {
		context.log.error(e, `Failed to fetch user ${username}`);
		return new Date().toISOString(); // Fallback to "now" (0 age) -> might trigger spam check if strict
	}
}

function getAccountAgeDays(createdAt: string): number {
	const created = new Date(createdAt);
	const now = new Date();
	const diffTime = Math.abs(now.getTime() - created.getTime());
	return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function containsKeywords(text: string, keywords: string[]): boolean {
	const lowerText = text.toLowerCase();
	return keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()));
}

function countLinks(text: string): number {
	const urlRegex = /(https?:\/\/[^\s]+)/g;
	const matches = text.match(urlRegex);
	return matches ? matches.length : 0;
}

async function markAsSpam(context: Context, reason: string, dryRun = false) {
	context.log.info(`Spam detected: ${reason}`);

	if (dryRun) {
		context.log.info(
			`DRY RUN: Would have marked as spam and closed. Reason: ${reason}`,
		);
		return;
	}

	// Add 'spam' label
	try {
		await context.octokit.issues.addLabels(
			context.issue({
				labels: ["spam"],
			}),
		);
	} catch (e) {
		// ignore if label doesn't exist or failure
		context.log.warn(e, "Could not add spam label");
	}

	// Close the issue/PR
	const params = context.issue({
		state: "closed" as const,
		state_reason: "not_planned" as const,
	}); // state_reason available for issues

	// For PRs, state_reason might not be valid in types depending on version, but valid in API for closing
	// If it's a PR, we just close it.
	if ("pull_request" in context.payload) {
		const prPayload = context.payload as typeof context.payload & {
			pull_request: { number: number };
		};
		await context.octokit.pulls.update({
			...context.repo(),
			pull_number: prPayload.pull_request.number,
			state: "closed",
		});
	} else if ("issue" in context.payload) {
		await context.octokit.issues.update(params);
	}

	// Comment
	await context.octokit.issues.createComment(
		context.issue({
			body: `This item has been automatically marked as spam and closed. Reason: ${reason}`,
		}),
	);
}

async function checkTemplateSimilarity(
	context: Context,
	body: string,
	isPR: boolean,
	maxSimilarity: number,
): Promise<boolean> {
	if (!body) return true; // Empty body is basically 100% similar to empty template or just bad

	const templates: string[] = [];

	try {
		if (isPR) {
			// Check default locations
			const possiblePaths = [
				".github/pull_request_template.md",
				".github/PULL_REQUEST_TEMPLATE.md",
				"pull_request_template.md",
				"PULL_REQUEST_TEMPLATE.md",
			];

			for (const path of possiblePaths) {
				const content = await getFileContent(context, path);
				if (content) {
					templates.push(content);
					break; // Only use the first found main template
				}
			}
		} else {
			// Issues - check .github/ISSUE_TEMPLATE/ folder
			try {
				const { data: contents } = await context.octokit.repos.getContent(
					context.repo({
						path: ".github/ISSUE_TEMPLATE",
					}),
				);

				if (Array.isArray(contents)) {
					for (const item of contents) {
						if (item.type === "file" && item.name.endsWith(".md")) {
							const content = await getFileContent(context, item.path);
							if (content) templates.push(content);
						}
					}
				}
			} catch {
				// Folder might not exist, check single file
				const possiblePaths = [
					".github/ISSUE_TEMPLATE.md",
					"ISSUE_TEMPLATE.md",
				];
				for (const path of possiblePaths) {
					const content = await getFileContent(context, path);
					if (content) {
						templates.push(content);
						break;
					}
				}
			}
		}
	} catch (e) {
		context.log.warn(e, "Failed to fetch templates for similarity check");
		return false; // Fail open
	}

	if (templates.length === 0) return false;

	// Check similarity against ALL templates. If ANY match closely, it's spam.
	for (const template of templates) {
		const similarity = calculateSimilarity(body, template);
		context.log.debug(`Template similarity: ${similarity}%`);
		if (similarity >= maxSimilarity) {
			return true;
		}
	}

	return false;
}

async function getFileContent(
	context: Context,
	path: string,
): Promise<string | null> {
	try {
		const { data } = await context.octokit.repos.getContent(
			context.repo({ path }),
		);
		if ("content" in data && !Array.isArray(data)) {
			return Buffer.from(data.content, "base64").toString("utf-8");
		}
	} catch {
		return null;
	}
	return null;
}

function calculateSimilarity(s1: string, s2: string): number {
	// Normalize strings: remove whitespace, newlines?
	// Actually, keeping structure might be important, but usually we want to ignore whitespace differences.
	// Let's strip whitespace for a content check.
	const clean1 = s1.trim();
	const clean2 = s2.trim();

	if (clean1 === clean2) return 100;
	if (clean1.length === 0 && clean2.length === 0) return 100;
	if (clean1.length === 0 || clean2.length === 0) return 0;

	const distance = levenshtein.get(clean1, clean2);
	const maxLength = Math.max(clean1.length, clean2.length);

	if (maxLength === 0) return 100;

	const similarity = (1 - distance / maxLength) * 100;
	return similarity;
}
