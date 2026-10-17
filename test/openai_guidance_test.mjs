import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import openaiGuidance from "../extensions/openai-guidance/index.ts";
import { rules } from "../extensions/openai-guidance/catalog.ts";
import { guidanceBlock, loadTexts, modelFamily, parseConfig, selectRules } from "../extensions/openai-guidance/guidance.ts";

const models = [
	["gpt-5", "gpt-5"],
	["gpt-5-mini", "gpt-5"],
	["gpt-5-codex", "gpt-5"],
	["gpt-5.6-sol", "gpt-5"],
	["gpt-5.6-luna", "gpt-5"],
	["gpt-5.9-future", "gpt-5"],
	["gpt-5-astra", "gpt-5"],
	["gpt-6", "gpt-6"],
	["gpt-6-sol", "gpt-6"],
	["gpt-6.1-sol", "gpt-6"],
	["gpt-6-luna", "gpt-6"],
	["gpt-6-astra", "gpt-6"],
	["gpt-6-astra-pro", "gpt-6"],
	["gpt-6.1-astra", "gpt-6"],
	["gpt-6.1-sol-2026-10-01", "gpt-6"],
	["gpt-6.9-future", "gpt-6"],
	["gpt-60-prefix", "gpt-6"],
];

function selectedIds(id, disabled = [], tools = [], provider = "openai") {
	return selectRules({ id, provider }, tools, { disabled }).map((rule) => rule.id);
}

for (const provider of ["openai", "openai-codex"]) {
	test(`${provider} selects generation guidance for every supported prefix`, () => {
		for (const [id, family] of models) {
			assert.equal(modelFamily({ id, provider }), family, id);
			const ids = selectedIds(id, [], [], provider);
			assert.ok(ids.includes("codex.correctness"), id);
			assert.equal(ids.includes("astra.initiative"), family === "gpt-6", id);
			assert.equal(ids.includes("astra.testing-stop"), family === "gpt-6", id);
			assert.equal(ids.includes("gpt-5.6.stop"), family === "gpt-5", id);
			assert.equal(ids.includes("gpt-5.6.validation"), family === "gpt-5", id);
			assert.equal(ids.filter((rule) => rule.endsWith(".updates")).length, 1, id);
			assert.equal(new Set(ids).size, ids.length, id);
		}
	});
}

test("shares authorization, evidence, and artifact policy with every supported model", () => {
	for (const [id] of models) {
		const ids = selectedIds(id);

		for (const suffix of ["scope", "preserve-artifact", "citations", "prerequisites", "frontend", "visual-validation"]) {
			assert.ok(ids.includes(`gpt-5.6.${suffix}`), `${id}: ${suffix}`);
		}
	}
});

test("does not enable guidance for other models or providers", () => {
	assert.equal(modelFamily(), undefined);

	for (const id of ["gpt-4o", "gpt-7", "o3", "claude-sonnet-4-6", "prefix-gpt-6.1-sol"]) {
		assert.equal(modelFamily({ id, provider: "openai" }), undefined, id);
		assert.deepEqual(selectedIds(id), []);
	}

	for (const provider of ["anthropic", "openrouter", "custom"]) {
		assert.equal(modelFamily({ id: "gpt-6.1-sol", provider }), undefined, provider);
		assert.deepEqual(selectedIds("gpt-6.1-sol", [], [], provider), []);
	}
});

test("preserves every existing opt-out ID across generation selection", () => {
	assert.equal(rules.length, 70);
	assert.equal(new Set(rules.map((rule) => rule.id)).size, 70);

	for (const rule of rules) {
		const config = parseConfig({ disabled: [rule.id, rule.id] });
		assert.deepEqual(config.disabled, [rule.id]);

		for (const id of ["gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-astra"]) {
			assert.ok(!selectedIds(id, config.disabled, ["subagent", "update_plan"]).includes(rule.id), `${id}: ${rule.id}`);
		}
	}

	assert.deepEqual(selectedIds("gpt-6.1-sol", rules.map((rule) => rule.id)), []);
});

test("does not restore disabled update or validation instructions through a different rule ID", () => {
	for (const disabled of ["gpt-5.6.updates", "astra.updates"]) {
		for (const id of ["gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-astra"]) {
			assert.ok(!selectedIds(id, [disabled]).some((rule) => rule.endsWith(".updates")));
		}
	}

	assert.ok(!selectedIds("gpt-6.1-sol", ["gpt-5.6.validation"]).includes("astra.testing-stop"));
	assert.ok(selectedIds("gpt-6.1-sol", ["gpt-5.6.validation"]).includes("astra.testing-meaningful"));
});

test("retains planning and delegation tool gates", () => {
	for (const [id] of models) {
		assert.ok(!selectRules({ id, provider: "openai" }, [], { disabled: [] }).some((rule) => rule.tool));
		assert.ok(selectedIds(id, [], ["update_plan"]).includes("codex.plan-update"));
		assert.equal(selectedIds(id, [], ["subagent"]).includes("astra.delegation"), id.startsWith("gpt-6"));
	}

	assert.ok(!selectedIds("gpt-6.1-sol", ["astra.delegation"], ["subagent"]).includes("astra.delegation"));
});

test("keeps strict configuration validation", () => {
	assert.deepEqual(parseConfig({}), { disabled: [] });

	for (const config of [null, [], { enabled: [] }, { disabled: ["unknown.rule"] }, { disabled: [1] }]) {
		assert.throws(() => parseConfig(config));
	}
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

test("replaces legacy guidance with GPT-6 guidance once through model switches", (t) => {
	const h = harness(t);
	const base = "Base prompt with literal <pi-openai-guidance> user text";
	const legacy = h.start("gpt-5.6-sol", base).systemPrompt;
	assert.match(legacy, /### gpt-5\.6\.stop/);
	const sol = h.start("gpt-6.1-sol", legacy).systemPrompt;
	assert.ok(sol.startsWith(base));
	assert.match(sol, /### astra\.initiative/);
	assert.match(sol, /### gpt-5\.6\.scope/);
	assert.doesNotMatch(sol, /### gpt-5\.6\.stop/);
	assert.equal(h.start("gpt-6.1-sol", sol).systemPrompt, sol);
	assert.equal(h.start("gpt-6-astra", sol).systemPrompt, sol);
	assert.equal(h.start("gpt-4o", sol).systemPrompt, base);
	assert.equal(h.start("gpt-4o"), undefined);
});

test("rereads historical opt-outs on each GPT-6.1 Sol turn", (t) => {
	const h = harness(t);
	const initial = h.start("gpt-6.1-sol").systemPrompt;
	assert.match(initial, /### astra\.initiative/);
	assert.match(initial, /### astra\.updates/);
	const directory = join(h.home, ".pi", "agent");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "openai-guidance.json"), JSON.stringify({ disabled: ["astra.initiative", "gpt-5.6.updates"] }));
	const next = h.start("gpt-6.1-sol", initial).systemPrompt;
	assert.match(next, /<pi-openai-guidance>/);
	assert.doesNotMatch(next, /### astra\.initiative|### astra\.updates/);
	writeFileSync(join(directory, "openai-guidance.json"), "{ invalid");
	assert.throws(() => h.start("gpt-6.1-sol"), /Invalid OpenAI guidance config/);
});

test("GPT-6 injected policy preserves task, permission, format, and required-check boundaries", () => {
	const texts = loadTexts();
	const prompt = guidanceBlock(selectRules({ id: "gpt-6.1-sol", provider: "openai" }, ["subagent"], { disabled: [] }), texts).replace(/\s+/g, " ");
	assert.match(prompt, /Do not implement changes unless the request also asks for them/);
	assert.match(prompt, /Require confirmation for external writes/);
	assert.match(prompt, /Reversibility alone does not authorize/);
	assert.match(prompt, /Earlier approval applies only to the action and scope it actually authorized/);
	assert.match(prompt, /higher-priority instructions or mandatory harness/);
	assert.match(prompt, /operator has authorized delegation/);
	assert.match(prompt, /do not delegate recursively when your role forbids it/);
	assert.match(prompt, /preserve the user's requested format, schemas, exact wording/);
	assert.match(prompt, /complete required checks/);
	assert.match(prompt, /subject to the user's test-writing constraints/);
});
