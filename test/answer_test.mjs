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

for (const choices of [
	"Choices: red / blue",
	"Choices: red, blue",
	"Choices:\n- red\n- blue",
	"1. red\n2. blue",
	"A) red\nB) blue",
	"(a) red\n(b) blue",
]) {
	test(`answer RPC select parses ${JSON.stringify(choices)}`, async () => {
		const question = `Which color?\n${choices}`;

		const execute = harness({
			async select(title, options) {
				assert.equal(title, `${question}\n\nChoose a color`);
				assert.deepEqual(options, ["red", "blue", "Other (type an answer)"]);

				return "blue";
			},
		});

		const result = await execute([{ question, context: "Choose a color" }]);
		assert.deepEqual(result.details, {
			cancelled: false,
			answers: `Q: ${question}\n> Choose a color\nA: blue`,
		});
		assert.equal(result.content[0].text, `The user answered your questions:\n\n${result.details.answers}`);
	});
}

test("answer RPC supports Other and free-text questions in order", async () => {
	const inputs = ["green", "Nate"];

	const execute = harness({
		async select() {
			return "Other (type an answer)";
		},
		async input(title, placeholder) {
			assert.ok(title);
			assert.equal(placeholder, "Type your answer");

			return inputs.shift();
		},
	});

	const result = await execute([{ question: "Color? Choices: red / blue" }, { question: "Name?" }]);
	assert.equal(result.details.answers, "Q: Color? Choices: red / blue\nA: green\n\nQ: Name?\nA: Nate");
});

for (const question of ["Color? Choices: red / blue", "Name?"]) {
	test(`answer RPC cancellation stops the round: ${question}`, async () => {
		let calls = 0;

		const cancel = async () => {
			calls++;

			return undefined;
		};

		const result = await harness({ select: cancel, input: cancel })([{ question }, { question: "Never asked" }]);
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

			return "blue";
		},
	})([{ question: "Color? Choices: red / blue" }], controller.signal);

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
