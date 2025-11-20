import type { Context } from "probot";
import type { Config } from "../config.js";

export async function handleCommunity(context: Context, config: Config) {
	const { payload } = context;
	const isIssue = "issue" in payload;
	const isPR = "pull_request" in payload;
	if (!isIssue && !isPR) return;

	if (payload.action !== "opened") return; // Only on open

	const item = (isPR ? payload.pull_request : payload.issue) as {
		author_association: string;
		body: string;
		title: string;
	};
	const authorAssociation = item.author_association;
	const body = item.body || "";
	const title = item.title || "";

	// 1. Empty Body Check
	if (!body.trim() && config.pr.requireBody) {
		if (config.dryRun) {
			context.log.info("DRY RUN: Would have commented about empty body.");
		} else {
			await context.octokit.issues.createComment(
				context.issue({
					body: "Hi there! It looks like you didn't provide a description. Please update the issue/PR with more details so we can help you better.",
				}),
			);
		}
	}

	// 2. Welcome Message
	const isFirstTime =
		authorAssociation === "FIRST_TIMER" ||
		authorAssociation === "FIRST_TIME_CONTRIBUTOR";

	// Note: "NONE" might be returned for first timers if the platform hasn't updated status yet or in some contexts.
	// But relying on FIRST_TIMER / FIRST_TIME_CONTRIBUTOR is standard.
	// If we want to be sure, we could query the API, but let's stick to association for now + a flag if "NONE" should be treated as such?
	// Actually, "NONE" just means no association. It is the default for new users who haven't contributed.
	// So we might double-check if they have prior events.
	// For now, let's trust the standard values. `FIRST_TIMER` is for issues, `FIRST_TIME_CONTRIBUTOR` for PRs.

	if (isFirstTime && config.community.welcomeMessage) {
		if (config.dryRun) {
			context.log.info("DRY RUN: Would have posted welcome message.");
		} else {
			await context.octokit.issues.createComment(
				context.issue({
					body: config.community.welcomeMessage,
				}),
			);
		}

		if (config.community.newContributorLabel) {
			if (config.dryRun) {
				context.log.info(
					`DRY RUN: Would have added label: ${config.community.newContributorLabel}`,
				);
			} else {
				try {
					await context.octokit.issues.addLabels(
						context.issue({
							labels: [config.community.newContributorLabel],
						}),
					);
				} catch (e) {
					context.log.warn(e, "Failed to add label");
				}
			}
		}
	}

	// 3. Auto Labeler
	const labelsToAdd: string[] = [];
	for (const [keyword, label] of Object.entries(config.community.autoLabeler)) {
		const regex = new RegExp(keyword, "i");
		if (regex.test(title) || regex.test(body)) {
			labelsToAdd.push(label);
		}
	}

	if (labelsToAdd.length > 0) {
		// Deduplicate
		const uniqueLabels = [...new Set(labelsToAdd)];
		if (config.dryRun) {
			context.log.info(
				`DRY RUN: Would have added labels: ${uniqueLabels.join(", ")}`,
			);
		} else {
			try {
				await context.octokit.issues.addLabels(
					context.issue({
						labels: uniqueLabels,
					}),
				);
			} catch (e) {
				context.log.warn(e, "Failed to auto-label");
			}
		}
	}
}
