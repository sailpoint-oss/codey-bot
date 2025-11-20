import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import probotApp from "../src/index.ts";

const issueCreatedBody = {
	body: "Thanks for opening your first issue/PR! We'll take a look soon.",
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = readFileSync(
	path.join(__dirname, "fixtures/mock-cert.pem"),
	"utf-8",
);

const payload = JSON.parse(
	readFileSync(path.join(__dirname, "fixtures/issues.opened.json"), "utf-8"),
);

describe("My Probot app", () => {
	let probot: Probot;

	beforeEach(() => {
		nock.disableNetConnect();
		probot = new Probot({
			appId: 123,
			privateKey,
			// disable request throttling and retries for testing
			Octokit: ProbotOctokit.defaults({
				retry: { enabled: false },
				throttle: { enabled: false },
			}),
		});
		// Load our app into probot
		probot.load(probotApp);
	});

	test("creates a comment when an issue is opened (mocking config existence)", async () => {
		const mock = nock("https://api.github.com")
			// Test that we correctly return a test token
			.post("/app/installations/2/access_tokens")
			.reply(200, {
				token: "test",
				permissions: {
					issues: "write",
				},
			})

			// Mock config load - MUST EXIST for live run
			.get("/repos/hiimbex/testing-things/contents/.github%2Fcodey-bot.yml")
			.reply(200, {
				content: Buffer.from("spam:\n  enabled: false").toString("base64"),
			})

			// Test that a comment is posted
			.post(
				"/repos/hiimbex/testing-things/issues/1/comments",
				(body: { body: string }) => {
					expect(body).toMatchObject(issueCreatedBody);
					return true;
				},
			)
			.reply(200);

		// Receive a webhook event
		await probot.receive({ name: "issues", payload, id: "test" });

		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	afterEach(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});
});
