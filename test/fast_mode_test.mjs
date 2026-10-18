import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import "./support/pi_tui_loader.mjs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const compatSource = `
let raw;
export const setRawStream = (stream) => { raw = stream; };
export const openAIResponsesApi = () => ({ stream: (...args) => raw(...args) });
export const openAICodexResponsesApi = openAIResponsesApi;
`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		return specifier === "@earendil-works/pi-ai/compat" &&
			(context.parentURL === import.meta.url || context.parentURL?.endsWith("/extensions/fast-mode/index.ts"))
			? { url: `data:text/javascript,${encodeURIComponent(compatSource)}`, shortCircuit: true }
			: nextResolve(specifier, context);
	},
});

const { setRawStream } = await import("@earendil-works/pi-ai/compat");

const { default: fastMode } = await import("../extensions/fast-mode/index.ts");

function model(id = "gpt-6.1-sol", provider = "openai") {
	return {
		id,
		provider,
		api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		maxTokens: 64_000,
		cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 4 },
	};
}

function message(current) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		api: current.api,
		provider: current.provider,
		model: current.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1_000_000,
			output: 500_000,
			cacheRead: 250_000,
			cacheWrite: 125_000,
			totalTokens: 1_875_000,
			cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, total: 3996 },
		},
	};
}

function harness(t, config = {}) {
	const root = mkdtempSync(join(tmpdir(), "fast-mode-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const globalPath = join(root, "agent", "extensions", "pi-fast-mode.json");
	const projectPath = join(root, "project", ".pi", "extensions", "pi-fast-mode.json");
	mkdirSync(dirname(globalPath), { recursive: true });
	writeFileSync(globalPath, JSON.stringify({ active: false, persistState: false, ...config }));

	const handlers = new Map();
	const commands = new Map();
	const providers = new Map();
	const statuses = new Map();
	const calls = [];
	let rawStream;
	setRawStream((current, context, options) => {
		calls.push({ model: current, context, options });

		if (rawStream) return rawStream;
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: message(current) });
		stream.end();

		return stream;
	});

	const ctx = {
		cwd: join(root, "project"),
		model: model(),
		sessionManager: { getEntries: () => [], getBranch: () => [] },
		ui: { setStatus: (key, text) => statuses.set(key, text), notify() {} },
	};

	fastMode({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerProvider: (name, provider) => providers.set(name, provider),
		appendEntry() {},
	});

	return {
		ctx,
		calls,
		statuses,
		globalPath,
		projectPath,
		setRawStream(stream) {
			rawStream = stream;
		},
		emit: (name) => handlers.get(name)({ reason: "new" }, ctx),
		command: (args) => commands.get("fast").handler(args, ctx),
		stream: () => providers.get(ctx.model.provider).streamSimple(ctx.model, { messages: [] }, {}),
	};
}

function assertPricing(h, result, multiplier) {
	assert.equal(h.statuses.get("fast-mode"), `⚡ FAST · $ ${multiplier}×`);
	assert.deepEqual(result.usage.cost, {
		input: 2 * multiplier,
		output: 4 * multiplier,
		cacheRead: 0.25 * multiplier,
		cacheWrite: 0,
		total: 6.25 * multiplier,
	});
	assert.equal(result.usage.cacheWrite, 125_000);
	assert.equal(result.usage.totalTokens, 1_875_000);
}

test("reads global fast-mode config from PI_CODING_AGENT_DIR and preserves project overrides", async (t) => {
	const h = harness(t, { active: true });
	await h.emit("session_start");
	assertPricing(h, await h.stream().result(), 2);
	assert.equal(h.calls.at(-1).options.serviceTier, "priority");

	mkdirSync(dirname(h.projectPath), { recursive: true });
	writeFileSync(h.projectPath, JSON.stringify({ active: false }));
	await h.emit("session_start");
	await h.stream().result();
	assert.equal(h.statuses.get("fast-mode"), undefined);
	assert.equal(h.calls.at(-1).options.serviceTier, undefined);
});

test("/fast injects priority only while active and for models surviving allowlist and blocklist", async (t) => {
	const h = harness(t, {
		allowlist: ["openai/custom-model"],
		blocklist: ["openai/gpt-6-luna"],
	});

	await h.emit("session_start");
	await h.stream().result();
	assert.equal(h.calls.at(-1).options.serviceTier, undefined);

	await h.command("on");
	assertPricing(h, await h.stream().result(), 2);
	assert.equal(h.calls.at(-1).options.serviceTier, "priority");

	for (const id of ["gpt-6-luna", "unsupported"]) {
		h.ctx.model = model(id);
		await h.emit("model_select");
		await h.stream().result();
		assert.equal(h.calls.at(-1).options.serviceTier, undefined);
		assert.equal(h.statuses.get("fast-mode"), undefined);
	}

	h.ctx.model = model("custom-model");
	await h.emit("model_select");
	assertPricing(h, await h.stream().result(), 2);
	assert.equal(h.calls.at(-1).options.serviceTier, "priority");

	await h.command("off");
	await h.stream().result();
	assert.equal(h.calls.at(-1).options.serviceTier, undefined);
	assert.equal(h.statuses.get("fast-mode"), undefined);
});

test("footer and terminal done/error costs agree for every built-in model and fallback", async (t) => {
	const h = harness(t, { allowlist: ["openai/custom-model"] });
	await h.command("on");

	const rates = [
		["openai", "gpt-6.1-sol", 2],
		["openai", "gpt-6-sol", 2],
		["openai", "gpt-6-astra", 2],
		["openai", "gpt-6-luna", 2],
		["openai", "custom-model", 2],
		["openai-codex", "gpt-5.6-sol", 2.5],
		["openai-codex", "gpt-5.6-terra", 2.5],
		["openai-codex", "gpt-5.6-luna", 2.5],
		["openai-codex", "gpt-5.5", 2.5],
		["openai-codex", "gpt-5.4", 2],
	];

	for (const [provider, id, multiplier] of rates) {
		h.ctx.model = model(id, provider);
		await h.emit("model_select");

		for (const type of ["done", "error"]) {
			const raw = createAssistantMessageEventStream();
			const final = message(h.ctx.model);

			if (type === "error") {
				final.stopReason = "error";
				final.errorMessage = "Upstream error event";
			}

			raw.push(type === "done" ? { type, reason: "stop", message: final } : { type, reason: "error", error: final });
			raw.end();
			h.setRawStream(raw);
			const output = h.stream();
			const events = await Array.fromAsync(output);
			assert.equal(events[0].type, type);
			assert.equal(await output.result(), final);
			assertPricing(h, final, multiplier);
		}
	}
});

test(
	"upstream iterator and result failures become terminal error messages without unhandled rejections",
	{ timeout: 2000 },
	async (t) => {
		const h = harness(t);
		await h.command("on");
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		t.after(() => process.off("unhandledRejection", onUnhandled));

		for (const failure of ["iterator", "result", "partial"]) {
			const partial = message(h.ctx.model);
			h.setRawStream({
				async *[Symbol.asyncIterator]() {
					if (failure === "partial") yield { type: "start", partial };

					if (failure !== "result") throw new Error(`${failure} failed`);
				},
				async result() {
					throw new Error("result failed");
				},
			});
			const stream = h.stream();
			const events = await Array.fromAsync(stream);
			const event = events.at(-1);
			assert.equal(event?.type, "error");
			assert.equal(event.reason, "error");
			const result = await stream.result();
			assert.equal(result, event.error);
			assert.equal(result.stopReason, "error");
			assert.equal(result.errorMessage, `${failure} failed`);
			assert.equal(result.model, h.ctx.model.id);
			assert.equal(result.provider, h.ctx.model.provider);
			assert.equal(result.api, h.ctx.model.api);

			if (failure === "partial") assertPricing(h, result, 2);
			else assert.equal(result.usage.cost.total, 0);
		}

		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	},
);
