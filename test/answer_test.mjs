import assert from "node:assert/strict";
import { test } from "node:test";
import "./support/pi_tui_loader.mjs";

const { default: answerExtension } = await import("../extensions/answer.ts");

function harness(ui, mode = "rpc") {
	let tool;
	answerExtension({
		registerTool(value) {
			tool = value;
		},
		registerCommand() {},
		registerShortcut() {},
	});

	return (questions, signal) => tool.execute("test", { questions }, signal, undefined, { mode, hasUI: true, ui });
}

test("answer RPC select letters structured choices and marks the recommendation", async () => {
	const execute = harness({
		async select(title, options) {
			assert.equal(title, "1. Which color?\n\nChoose a color");
			assert.deepEqual(options, ["A. red", "B. blue (recommended)", "Other (type an answer)"]);

			return "B. blue (recommended)";
		},
	});

	const result = await execute([
		{ question: "1. Which color?", context: "Choose a color", choices: ["red", "blue"], recommended: 1 },
	]);

	assert.deepEqual(result.details, {
		cancelled: false,
		answers: "Q: 1. Which color?\n\nChoose a color\n\nA. red\nB. blue (recommended)\nA: B. blue",
	});
	assert.equal(result.content[0].text, `The user answered your questions:\n\n${result.details.answers}`);
});

test("answer rejects a recommendation outside its choices", async () => {
	await assert.rejects(harness({})([{ question: "Color?", choices: ["red", "blue"], recommended: 2 }]), /recommended/);
});

test("answer RPC supports Other and free-text questions in order", async () => {
	const inputs = ["green", "Nate"];

	const execute = harness({
		async select() {
			return "Other (type an answer)";
		},
		async input(title, placeholder) {
			assert.equal(title, inputs.length === 2 ? "Color?" : "Name?\n\nFirst name");
			assert.equal(placeholder, "Type your answer");

			return inputs.shift();
		},
	});

	const result = await execute([
		{ question: "Color?", context: "Pick one", choices: ["red", "blue"] },
		{ question: "Name?", context: "First name" },
	]);

	assert.equal(
		result.details.answers,
		"Q: Color?\n\nPick one\n\nA. red\nB. blue\nA: green\n\nQ: Name?\n\nFirst name\nA: Nate",
	);
});

for (const question of [{ question: "Color?", choices: ["red", "blue"] }, { question: "Name?" }]) {
	test(`answer RPC cancellation stops the round: ${question.question}`, async () => {
		let calls = 0;

		const cancel = async () => {
			calls++;

			return undefined;
		};

		const result = await harness({ select: cancel, input: cancel })([question, { question: "Never asked" }]);
		assert.equal(calls, 1);
		assert.equal(result.details.cancelled, true);
		assert.equal(result.terminate, true);
	});
}

test("answer passes cancellation signal to RPC dialogs", async () => {
	const controller = new AbortController();

	const result = await harness({
		async select(_title, _options, options) {
			assert.equal(options.signal, controller.signal);
			controller.abort();

			return "A. red";
		},
	})([{ question: "Color?", choices: ["red", "blue"] }], controller.signal);

	assert.equal(result.details.cancelled, true);
});

test("answer retains the custom TUI path", async () => {
	const result = await harness(
		{
			async custom() {
				return "Q: Color?\nA: blue";
			},
		},
		"tui",
	)([{ question: "Color?" }]);

	assert.equal(result.details.answers, "Q: Color?\nA: blue");
});
