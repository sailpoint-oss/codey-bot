import type { Context } from "probot";
import type { Config } from "../config.js";

export async function handleFormat(context: Context, config: Config) {
	const { payload } = context;
	if (!("pull_request" in payload)) return;

	const pr = payload.pull_request;

	// Only run if enabled and action is relevant
	if (!config.pr.autoFormat) return;
	const action = payload.action;
	if (action !== "opened" && action !== "synchronize") return;

	// Check if biome is used in the repository
	try {
		await context.octokit.repos.getContent(
			context.repo({
				path: "biome.json",
			}),
		);
	} catch (e) {
		// biome.json not found, skip formatting
		context.log.debug(e, "No biome.json found, skipping format check");
		return;
	}

	// Trigger a workflow dispatch event to run the format check
	const owner = context.repo().owner;
	const repo = context.repo().repo;
	const ref = pr.head.ref;

	if (config.dryRun) {
		context.log.info(
			`DRY RUN: Would have triggered format workflow for PR #${pr.number}`,
		);
		return;
	}

	try {
		// Dispatch a workflow event
		await context.octokit.repos.createDispatchEvent({
			owner,
			repo,
			event_type: "format-check",
			client_payload: {
				pr_number: pr.number,
				ref: ref,
				sha: pr.head.sha,
			},
		});
		context.log.info(`Triggered format check for PR #${pr.number}`);
	} catch (e) {
		context.log.error(e, "Failed to trigger format workflow");
	}
}
