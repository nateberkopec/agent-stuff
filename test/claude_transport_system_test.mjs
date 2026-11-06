import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import "./support/pi_tui_loader.mjs";

const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");

const loader = createJiti(import.meta.url);

const { runClaudeRequest } = await loader.import("../vendor/pi-claude-code/src/claude-cli.ts");

const { retryAssistantCall } = await import("@earendil-works/pi-ai/compat");

const cli = `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: "max" }));
  process.exit(0);
}
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery !== false) {
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [frame.message] }),
    });
    await response.arrayBuffer();
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: frame.shouldQuery === false ? 0 : 1 }));
}
`;

async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	return `http://127.0.0.1:${server.address().port}`;
}

async function runTurns(upstreamUrl, timeoutMs = 5000) {
	const home = await mkdtemp(path.join(tmpdir(), "claude-transport-system-"));
	const command = path.join(home, "claude.mjs");
	await writeFile(command, cli);
	await chmod(command, 0o700);
	let attempts = 0;
	const retries = [];

	try {
		const result = await retryAssistantCall(
			async () => {
				attempts++;

				try {
					const response = await runClaudeRequest({
						model: "opus",
						cwd: home,
						frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "ping" }] } }],
						systemPrompt: "Reply with pong",
						manifest: [],
						extraBody: {},
						timeoutMs,
						upstreamUrl,
						env: {
							HOME: home,
							PI_CLAUDE_CODE_COMMAND: command,
							ANTHROPIC_AUTH_TOKEN: undefined,
							ANTHROPIC_BASE_URL: undefined,
							ANTHROPIC_FOUNDRY_API_KEY: undefined,
							CLAUDE_CODE_USE_BEDROCK: undefined,
							CLAUDE_CODE_USE_VERTEX: undefined,
							CLAUDE_CODE_USE_FOUNDRY: undefined,
						},
					});

					return { stopReason: "stop", content: response.message.content };
				} catch (error) {
					return { stopReason: "error", errorMessage: error.message };
				}
			},
			{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
			undefined,
			{ onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => retries.push(errorMessage) },
		);

		return { result, attempts, retries };
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("a refused upstream connection is retried through the real Claude subprocess and relay", async () => {
	const server = net.createServer();
	const upstream = await listen(server);
	await new Promise((resolve) => server.close(resolve));
	const { result, attempts, retries } = await runTurns(upstream);
	assert.equal(attempts, 2);
	assert.equal(retries.length, 1);
	assert.match(result.errorMessage, /Claude Code upstream connection error/);
	assert.match(result.errorMessage, /ECONNREFUSED/);
});

test("a reset upstream connection retains its socket error and retries", async () => {
	const server = net.createServer((socket) => socket.once("data", () => socket.resetAndDestroy()));

	try {
		const { result, attempts } = await runTurns(await listen(server));
		assert.equal(attempts, 2);
		assert.match(result.errorMessage, /Claude Code upstream connection error/);
		assert.match(result.errorMessage, /ECONNRESET/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

for (const [status, message] of [
	[403, "Invalid credentials; diagnostic EHOSTUNREACH"],
	[402, "Subscription billing quota exceeded"],
]) {
	test(`HTTP ${status} upstream errors retain their wording without transport retries`, async () => {
		const server = http.createServer((request, response) => {
			request.resume();
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message } }));
		});

		try {
			const { result, attempts, retries } = await runTurns(await listen(server));
			assert.equal(attempts, 1);
			assert.deepEqual(retries, []);
			assert.match(result.errorMessage, /Incomplete Claude Code upstream response/);
			assert.ok(result.errorMessage.includes(message));
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
}

const stream = [
	{
		type: "message_start",
		message: {
			id: "msg_pool",
			type: "message",
			role: "assistant",
			model: "fixture",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `data: ${JSON.stringify(event)}\n\n`)
	.join("");

for (const closeIdle of [false, true]) {
	test(
		closeIdle
			? "a server-closed pooled socket is replaced without a transport retry"
			: "separate Claude subprocesses reuse an upstream connection after an eight-second gap",
		async () => {
			const sockets = [];
			let requests = 0;

			const server = http.createServer((request, response) => {
				requests++;
				request.resume();
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(stream);
			});

			server.keepAliveTimeout = 60_000;
			server.on("connection", (socket) => sockets.push(socket));

			try {
				const upstream = await listen(server);
				const first = await runTurns(upstream);
				assert.equal(first.result.stopReason, "stop");
				assert.equal(first.attempts, 1);

				if (closeIdle) {
					const closed = once(sockets[0], "close");
					server.closeIdleConnections();
					await closed;
					await setTimeout(20);
				} else {
					await setTimeout(8000);
				}

				const second = await runTurns(upstream);
				assert.equal(second.result.stopReason, "stop");
				assert.equal(second.attempts, 1);
				assert.deepEqual(second.retries, []);
				assert.equal(requests, 2);
				assert.equal(sockets.length, closeIdle ? 2 : 1);
			} finally {
				server.closeAllConnections();
				await new Promise((resolve) => server.close(resolve));
			}
		},
	);
}

test("a reused connection still obeys the individual Claude request timeout", async () => {
	let requests = 0;
	let connections = 0;

	const server = http.createServer((request, response) => {
		requests++;
		request.resume();

		if (requests === 1) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(stream);
		}
	});

	server.keepAliveTimeout = 60_000;
	server.on("connection", () => connections++);

	try {
		const upstream = await listen(server);
		const first = await runTurns(upstream);
		assert.equal(first.result.stopReason, "stop");
		const second = await runTurns(upstream, 2000);
		assert.equal(second.attempts, 2);
		assert.match(second.result.errorMessage, /timed out/);
		assert.equal(requests, 3);
		assert.equal(connections, 2);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
