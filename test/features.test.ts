import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import myProbotApp from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(
	path.join(__dirname, "fixtures/mock-cert.pem"),
	"utf-8",
);

interface LabelBody {
	labels: string[];
}

interface IssueUpdateBody {
	state: string;
}

interface CommentBody {
	body: string;
}

interface CheckRunBody {
	conclusion: string;
	output: {
		title: string;
	};
}

interface DispatchBody {
	event_type: string;
	client_payload: {
		pr_number: number;
	};
}

describe("Codey-Bot Features", () => {
	let probot: Probot;

	beforeEach(() => {
		nock.disableNetConnect();
		probot = new Probot({
			appId: 123,
			privateKey,
			Octokit: ProbotOctokit.defaults({
				retry: { enabled: false },
				throttle: { enabled: false },
			}),
		});
		probot.load(myProbotApp);
	});

	afterEach(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});

	test("Spam: detects keywords and closes issue", async () => {
		const payload = {
			action: "opened" as const,
			issue: {
				number: 1,
				title: "Cheap Meds for you",
				body: "Buy now!",
				user: { login: "spammer", created_at: "2020-01-01T00:00:00Z" },
			},
			repository: { owner: { login: "owner" }, name: "repo" },
			sender: { login: "spammer", created_at: "2020-01-01T00:00:00Z" },
			installation: { id: 2 },
		} as unknown as Parameters<typeof probot.receive>[0]["payload"];

		const mock = nock("https://api.github.com")
			.post("/app/installations/2/access_tokens")
			.reply(200, { token: "test" })
			.get("/repos/owner/repo/contents/.github%2Fcodey-bot.yml")
			.reply(200, {
				content: Buffer.from("spam:\n  enabled: true").toString("base64"),
			})
			.post("/repos/owner/repo/issues/1/labels", (body: LabelBody) => {
				expect(body.labels).toContain("spam");
				return true;
			})
			.reply(200)
			.patch("/repos/owner/repo/issues/1", (body: IssueUpdateBody) => {
				expect(body.state).toBe("closed");
				return true;
			})
			.reply(200)
			.post("/repos/owner/repo/issues/1/comments", (body: CommentBody) => {
				expect(body.body).toContain("spam");
				return true;
			})
			.reply(200);

		await probot.receive({ name: "issues", payload, id: "test" } as Parameters<
			typeof probot.receive
		>[0]);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	test("Community: welcomes first-time contributor", async () => {
		const payload = {
			action: "opened" as const,
			issue: {
				number: 2,
				title: "Valid Issue",
				body: "This is a valid issue.",
				user: { login: "newbie", created_at: "2020-01-01T00:00:00Z" },
				author_association: "FIRST_TIMER",
			},
			repository: { owner: { login: "owner" }, name: "repo" },
			sender: { login: "newbie", created_at: "2020-01-01T00:00:00Z" },
			installation: { id: 2 },
		} as unknown as Parameters<typeof probot.receive>[0]["payload"];

		const mock = nock("https://api.github.com")
			.post("/app/installations/2/access_tokens")
			.reply(200, { token: "test" })
			.get("/repos/owner/repo/contents/.github%2Fcodey-bot.yml")
			.reply(200, {
				content: Buffer.from("community:\n  welcomeMessage: Hello").toString(
					"base64",
				),
			})
			.post("/repos/owner/repo/issues/2/comments", (body: CommentBody) => {
				expect(body.body).toContain("Thanks for opening your first issue");
				return true;
			})
			.reply(200)
			.post("/repos/owner/repo/issues/2/labels", (body: LabelBody) => {
				expect(body.labels).toContain("first-time-contributor");
				return true;
			})
			.reply(200);

		await probot.receive({ name: "issues", payload, id: "test" } as Parameters<
			typeof probot.receive
		>[0]);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	test("PR: check fails for bad title", async () => {
		const payload = {
			action: "opened" as const,
			pull_request: {
				number: 3,
				title: "Bad Title",
				body: "Fixing stuff",
				user: { login: "dev", created_at: "2020-01-01T00:00:00Z" },
				head: { sha: "abcdef", ref: "feature-branch" },
				author_association: "CONTRIBUTOR",
			},
			repository: { owner: { login: "owner" }, name: "repo" },
			sender: { login: "dev", created_at: "2020-01-01T00:00:00Z" },
			installation: { id: 2 },
		} as unknown as Parameters<typeof probot.receive>[0]["payload"];

		nock("https://api.github.com")
			.post("/app/installations/2/access_tokens")
			.reply(200, { token: "test" })
			.get("/repos/owner/repo/contents/.github%2Fcodey-bot.yml")
			.reply(200, {
				content: Buffer.from("pr:\n  conventionalCommits: true").toString(
					"base64",
				),
			})
			.post("/repos/owner/repo/check-runs", (body: CheckRunBody) => {
				expect(body.conclusion).toBe("failure");
				expect(body.output.title).toContain("not follow Conventional Commits");
				return true;
			})
			.reply(200)
			.get("/repos/owner/repo/contents/biome.json")
			.reply(200, { type: "file", name: "biome.json" })
			.post("/repos/owner/repo/dispatches", (body: DispatchBody) => {
				expect(body.event_type).toBe("format-check");
				expect(body.client_payload.pr_number).toBe(3);
				return true;
			})
			.reply(204);

		await probot.receive({
			name: "pull_request",
			payload,
			id: "test",
		} as Parameters<typeof probot.receive>[0]);
	});

	test("Dry Run: Does NOT perform actions when config file is missing", async () => {
		const payload = {
			action: "opened" as const,
			issue: {
				number: 1,
				title: "Cheap Meds for you",
				body: "Buy now!",
				user: { login: "spammer", created_at: "2020-01-01T00:00:00Z" },
			},
			repository: { owner: { login: "owner" }, name: "repo" },
			sender: { login: "spammer", created_at: "2020-01-01T00:00:00Z" },
			installation: { id: 2 },
		} as unknown as Parameters<typeof probot.receive>[0]["payload"];

		const mock = nock("https://api.github.com")
			.post("/app/installations/2/access_tokens")
			.reply(200, { token: "test" })
			.get("/repos/owner/repo/contents/.github%2Fcodey-bot.yml")
			.reply(404)
			.get("/repos/owner/.github/contents/.github%2Fcodey-bot.yml")
			.reply(404);

		await probot.receive({ name: "issues", payload, id: "test" } as Parameters<
			typeof probot.receive
		>[0]);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});
});
