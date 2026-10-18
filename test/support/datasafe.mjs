import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("./datasafe_harness.ts", import.meta.url));

const PI = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));

const FAKE_KEYS = {
	ANTHROPIC_API_KEY: "fake",
	OPENAI_API_KEY: "fake",
	OPENROUTER_API_KEY: "fake",
	FIREWORKS_API_KEY: "fake",
	AI_GATEWAY_API_KEY: "fake",
};

const AMBIENT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(
		([name]) => !/^(PI_|GOOGLE_|GCLOUD_|AWS_|AZURE_|ANTHROPIC_|OPENAI_)|_API_KEY$|_TOKEN$/.test(name),
	),
);

export const OPENROUTER_US = "https://us.openrouter.ai/api/v1";

export const FIREWORKS_US = "https://us.api.fireworks.ai/inference/v1";

export const FIREWORKS_DOCS = "https://docs.fireworks.ai/serverless/us-only-serverless.md";

export function storedModel(provider, id, overrides = {}) {
	const base = {
		openrouter: {
			api: "anthropic-messages",
			baseUrl: "https://us.openrouter.ai/api",
			reasoning: false,
			maxTokens: 8192,
		},
		fireworks: { api: "openai-completions", baseUrl: FIREWORKS_US, reasoning: true, maxTokens: 131_072 },
	}[provider];

	return {
		id,
		name: id,
		provider,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		...base,
		...overrides,
	};
}

export function json(value, headers = {}) {
	return { body: JSON.stringify(value), headers };
}

const ids = (models) => models.map(({ provider, id }) => `${provider}/${id}`);

export function agent(t, files = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "datasafe-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = (name) => path.join(dir, name);

	const write = (name, value) => writeFileSync(file(name), JSON.stringify(value, null, 2));

	for (const [name, value] of Object.entries(files)) write(name, value);

	const log = () =>
		existsSync(file("harness-log.jsonl"))
			? readFileSync(file("harness-log.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
			: [];

	const env = ({ mode, offline = true, providers = [], payload, extra = {} } = {}) => ({
		...AMBIENT_ENV,
		HOME: dir,
		PI_CODING_AGENT_DIR: dir,
		...(offline && { PI_OFFLINE: "1" }),
		...(mode && { PI_DATASAFE_MODE: mode }),
		...(payload && { DATASAFE_HARNESS_PAYLOAD: JSON.stringify(payload) }),
		DATASAFE_HARNESS_PROVIDERS: providers.join(","),
		...FAKE_KEYS,
		...extra,
	});

	const pi = (args, options) => {
		const result = spawnSync(PI, ["--no-extensions", "--extension", HARNESS, ...args], {
			cwd: dir,
			env: env(options),
			encoding: "utf8",
			timeout: 30_000,
		});

		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	};

	return {
		dir,
		write,
		log,
		fetches: () => log().filter((entry) => entry.type === "fetch"),
		stored: () => JSON.parse(readFileSync(file("models-store.json"), "utf8")),
		pi,
		listModels: (search, options) =>
			pi(search === undefined ? ["--list-models"] : ["--list-models", search], options)
				.output.split("\n")
				.flatMap((line) => {
					const row = line.match(/^(\S+)\s+(\S+)\s+\d[\d.]*[KM]?\s/);

					return row ? [`${row[1]}/${row[2]}`] : [];
				}),
		prompt: (args, options) => pi([...args, "--no-tools", "--no-session", "-p", "hello"], options),
		refresh: async (session, args) => {
			await session.command(`/refresh-models ${args}`);

			return log()
				.filter((entry) => entry.type === "refresh")
				.at(-1).errors;
		},
		rpc: (args, options) => rpc(t, ["--no-extensions", "--extension", HARNESS, ...args], env(options), dir),
	};
}

function rpc(t, args, env, cwd) {
	const child = spawn(PI, [...args, "--mode", "rpc", "--no-session"], { cwd, env });
	const seen = [];
	const waiters = [];
	let stderr = "";
	let counter = 0;
	child.stderr.on("data", (chunk) => (stderr += chunk));
	t.after(() => child.kill());

	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.startsWith("{")) return;
		seen.push(JSON.parse(line));

		for (const waiter of waiters.slice()) waiter.check();
	});

	const waitFor = (match, from = 0) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`RPC wait timed out. stderr: ${stderr}`)), 15_000);

			const waiter = {
				check: () => {
					const found = seen.slice(from).find(match);

					if (!found) return;
					clearTimeout(timer);
					waiters.splice(waiters.indexOf(waiter), 1);
					resolve(found);
				},
			};

			waiters.push(waiter);
			waiter.check();
		});

	const send = async (command) => {
		const id = `request-${++counter}`;
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		const response = await waitFor((message) => message.type === "response" && message.id === id);

		if (!response.success) throw new Error(`RPC ${command.type} failed: ${JSON.stringify(response)}`);

		return response.data;
	};

	return {
		models: async () => ids((await send({ type: "get_available_models" })).models),
		command: (text) => send({ type: "prompt", message: text }),
		prompt: async (text) => {
			const from = seen.length;
			await send({ type: "prompt", message: text });
			await waitFor((message) => message.type === "agent_end", from);
		},
		close: () =>
			new Promise((resolve) => {
				child.on("exit", (code) => resolve(code));
				child.stdin.end();
			}),
	};
}

export async function eventually(check, timeout = 10_000) {
	const deadline = Date.now() + timeout;

	for (;;) {
		try {
			return await check();
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}
