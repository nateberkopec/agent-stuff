import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import openaiGuidance from "../extensions/openai-guidance/index.ts";
import { modelFamily, selectRules } from "../extensions/openai-guidance/guidance.ts";

const familyModels = [
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-codex",
	"gpt-5.6-sol",
	"gpt-5.6-luna",
	"gpt-5.9-future",
	"gpt-6",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.9-future",
];

for (const provider of ["openai", "openai-codex"]) {
	test(`${provider} enables family guidance for every GPT-5 and GPT-6 prefix`, () => {
		for (const id of familyModels) {
			assert.equal(modelFamily({ id, provider }), "family", id);
			const ids = selectRules({ id, provider }, [], { disabled: [] }).map((rule) => rule.id);
			assert.ok(ids.includes("codex.correctness"), id);
			assert.ok(ids.includes("gpt-5.6.stop"), id);
			assert.ok(!ids.some((rule) => rule.startsWith("astra.")), id);
		}
	});
}

test("Astra variants keep Astra rules instead of the generic family rules", () => {
	for (const id of ["gpt-6-astra", "gpt-6-astra-pro", "gpt-6.1-astra"]) {
		assert.equal(modelFamily({ id, provider: "openai" }), "astra", id);
		const ids = selectRules({ id, provider: "openai" }, [], { disabled: [] }).map((rule) => rule.id);
		assert.ok(ids.includes("astra.initiative"), id);
		assert.ok(ids.includes("codex.correctness"), id);
		assert.ok(!ids.includes("gpt-5.6.stop"), id);
	}
});

test("does not enable guidance for other models or providers", () => {
	assert.equal(modelFamily(), undefined);

	for (const id of ["gpt-4o", "gpt-7", "o3", "claude-sonnet-4-6", "prefix-gpt-6.1-sol"]) {
		assert.equal(modelFamily({ id, provider: "openai" }), undefined, id);
		assert.deepEqual(selectRules({ id, provider: "openai" }, [], { disabled: [] }), []);
	}

	for (const provider of ["anthropic", "openrouter", "custom"]) {
		assert.equal(modelFamily({ id: "gpt-6.1-sol", provider }), undefined, provider);
	}
});

test("broader matches still respect opt-outs and active tool requirements", () => {
	const model = { id: "gpt-6.1-sol", provider: "openai" };
	const withoutTools = selectRules(model, [], { disabled: ["codex.correctness"] });
	assert.ok(withoutTools.length > 0);
	assert.ok(!withoutTools.some((rule) => rule.id === "codex.correctness" || rule.tool));
	const withTools = selectRules(model, ["update_plan"], { disabled: [] });
	assert.ok(withTools.some((rule) => rule.id === "codex.plan-update"));
});

function harness(t) {
	const home = mkdtempSync(join(tmpdir(), "openai-guidance-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	const handlers = new Map();
	openaiGuidance({
		on: (name, handler) => handlers.set(name, handler),
		getActiveTools: () => [],
	});

	return {
		home,
		start: (id, systemPrompt = "Base prompt", provider = "openai") =>
			handlers.get("before_agent_start")({ systemPrompt }, { model: { id, provider } }),
	};
}

test("injects GPT-6.1 Sol guidance once and replaces it when switching models", (t) => {
	const h = harness(t);
	const sol = h.start("gpt-6.1-sol").systemPrompt;
	assert.match(sol, /^Base prompt\n\n<pi-openai-guidance>/);
	assert.match(sol, /### gpt-5\.6\.stop/);
	assert.equal(h.start("gpt-6.1-sol", sol).systemPrompt, sol);
	const astra = h.start("gpt-6-astra", sol).systemPrompt;
	assert.equal(astra.match(/<pi-openai-guidance>/g).length, 1);
	assert.match(astra, /### astra\.initiative/);
	assert.doesNotMatch(astra, /### gpt-5\.6\.stop/);
	assert.equal(h.start("gpt-4o", astra).systemPrompt, "Base prompt");
	assert.equal(h.start("gpt-4o"), undefined);
});

test("reads rule opt-outs again on each GPT-6.1 Sol turn", (t) => {
	const h = harness(t);
	assert.match(h.start("gpt-6.1-sol").systemPrompt, /### gpt-5\.6\.stop/);
	const directory = join(h.home, ".pi", "agent");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "openai-guidance.json"), JSON.stringify({ disabled: ["gpt-5.6.stop"] }));
	const next = h.start("gpt-6.1-sol").systemPrompt;
	assert.match(next, /<pi-openai-guidance>/);
	assert.doesNotMatch(next, /### gpt-5\.6\.stop/);
});
