import type { Probot } from "probot";
import { loadConfig } from "./config.js";
import { handleCommunity } from "./features/community.js";
import { handleFormat } from "./features/format.js";
import { handleSpamCheck } from "./features/spam.js";

export default (app: Probot) => {
	app.on(
		[
			"issues.opened",
			"issues.edited",
			"pull_request.opened",
			"pull_request.edited",
			"pull_request.synchronize",
			"issue_comment.created",
		],
		async (context) => {
			const config = await loadConfig(context);

			// 1. Spam Check
			// If spam is detected, it stops further processing (and closes the item)
			const isSpam = await handleSpamCheck(context, config);
			if (isSpam) return;

			// 2. Community Features
			// (Welcome messages, auto-labeling)
			await handleCommunity(context, config);

			// 4. Format Check
			// (Triggers workflow dispatch)
			await handleFormat(context, config);
		},
	);
};
