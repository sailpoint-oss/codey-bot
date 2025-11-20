import type { Context } from "probot";

export interface Config {
	dryRun?: boolean;
	spam: {
		enabled: boolean;
		keywords: string[];
		minAccountAgeDays: number;
		maxLinks: number;
		maxTemplateSimilarity: number; // percentage (0-100)
	};
	community: {
		welcomeMessage: string | null;
		newContributorLabel: string | null;
		autoLabeler: Record<string, string>; // keyword -> label
	};
	pr: {
		requireBody: boolean;
		conventionalCommits: boolean;
		autoFormat: boolean; // New config option
	};
}

export const DEFAULT_CONFIG: Config = {
	dryRun: false,
	spam: {
		enabled: true,
		keywords: ["spam", "buy now", "cheap meds"],
		minAccountAgeDays: 1,
		maxLinks: 10,
		maxTemplateSimilarity: 90,
	},
	community: {
		welcomeMessage:
			"Thanks for opening your first issue/PR! We'll take a look soon.",
		newContributorLabel: "first-time-contributor",
		autoLabeler: {
			bug: "bug",
			enhancement: "enhancement",
			feature: "enhancement",
		},
	},
	pr: {
		requireBody: true,
		conventionalCommits: true,
		autoFormat: true, // Default to true
	},
};

export const CONFIG_FILE = "codey-bot.yml";

export async function loadConfig(context: Context): Promise<Config> {
	const repoConfig = await context.config<Config>(CONFIG_FILE);
	const dryRun = !repoConfig; // If no config found, dry run is true.

	return {
		dryRun: repoConfig?.dryRun ?? dryRun,
		spam: { ...DEFAULT_CONFIG.spam, ...repoConfig?.spam },
		community: { ...DEFAULT_CONFIG.community, ...repoConfig?.community },
		pr: { ...DEFAULT_CONFIG.pr, ...repoConfig?.pr },
	};
}
