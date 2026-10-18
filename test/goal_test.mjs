import assert from "node:assert/strict";
import { test } from "node:test";
import goalExtension from "../extensions/goal.ts";

function harness({ branch = [], hasUI = false, confirm = true } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const messages = [];
	const confirmations = [];
	const statuses = [];

	const ctx = {
		hasUI,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "goal-test",
		},
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (key, text) => statuses.push({ key, text }),
			confirm: async (...args) => {
				confirmations.push(args);

				return confirm;
			},
		},
	};

	goalExtension({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message, options) => messages.push({ message, options }),
	});

	return {
		ctx,
		branch,
		messages,
		confirmations,
		statuses,
		emit: (name, event = {}) => handlers.get(name)(event, ctx),
		command: (args) => commands.get("goal").handler(args, ctx),
		async tool(name, params = {}) {
			return (await tools.get(name).execute("test", params, undefined, undefined, ctx)).details;
		},
		continuations: () => messages.filter(({ message }) => message.customType === "goal-continuation"),
		uiMessages: () => messages.filter(({ message }) => message.customType === "goal-ui"),
	};
}

function assistant(usage = {}, extra = {}) {
	return { role: "assistant", stopReason: "stop", usage, ...extra };
}

function storedGoal(status = "active", overrides = {}) {
	return {
		type: "custom",
		customType: "goal",
		data: {
			version: 2,
			action: "account",
			goal: {
				id: "persisted-goal",
				objective: "Finish the persisted objective",
				status,
				tokenBudget: 100,
				tokensUsed: 12,
				timeUsedSeconds: 7,
				createdAt: 100,
				updatedAt: 110,
				...overrides,
			},
		},
	};
}

test("active goals queue one continuation per turn, using followUp while busy", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Finish <the task> & verify" });
	assert.equal(h.continuations().length, 0);
	await h.emit("agent_start");
	await h.emit("agent_end", { messages: [assistant({ input: 10, output: 2 })] });
	assert.equal(h.continuations().length, 1);
	const first = h.continuations()[0];
	assert.deepEqual(first.options, { triggerTurn: true });
	assert.equal(first.message.display, false);
	assert.equal(first.message.details.goalId, h.branch[0].data.goal.id);
	assert.match(first.message.content, /Finish &lt;the task&gt; &amp; verify/);
	assert.match(first.message.content, /Tokens used: 12/);
	await h.emit("agent_end", { messages: [] });
	assert.equal(h.continuations().length, 1);
	await h.emit("agent_start");
	h.ctx.isIdle = () => false;
	await h.emit("agent_end", { messages: [assistant({ output: 3 })] });
	assert.equal(h.continuations().length, 2);
	assert.deepEqual(h.continuations()[1].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 15);
});

test("pending messages suppress automatic continuation until the next turn", async () => {
	const h = harness();
	await h.command("Finish the task");
	assert.equal(h.continuations().length, 1);
	await h.emit("agent_start");
	h.ctx.hasPendingMessages = () => true;
	await h.emit("agent_end", { messages: [assistant()] });
	assert.equal(h.continuations().length, 1);
	h.ctx.hasPendingMessages = () => false;
	await h.emit("agent_start");
	await h.emit("agent_end", { messages: [assistant()] });
	assert.equal(h.continuations().length, 2);
});

test("tokens belong only to the goal active at agent_start, even if completed during the turn", async () => {
	const h = harness();
	await h.emit("agent_start");
	await h.tool("create_goal", { objective: "Created mid-turn" });
	await h.emit("agent_end", { messages: [assistant({ output: 50 })] });
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 0);
	await h.command("pause");
	await h.emit("agent_start");
	await h.command("resume");
	await h.emit("agent_end", { messages: [assistant({ output: 50 })] });
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 0);
	await h.emit("agent_start");
	await h.tool("update_goal", { status: "complete" });
	await h.emit("agent_end", { messages: [assistant({ output: 9 })] });
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 9);
	assert.equal((await h.tool("get_goal")).goal.status, "complete");
	assert.equal(h.branch.at(-1).data.action, "account");
	const count = h.continuations().length;
	await h.emit("agent_start");
	await h.tool("create_goal", { objective: "Replacement mid-turn" });
	await h.emit("agent_end", { messages: [assistant({ output: 99 })] });
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 0);
	assert.equal(h.continuations().length, count + 1);
	await h.emit("agent_start");
	await h.command("clear");
	await h.tool("create_goal", { objective: "Different goal in an active turn" });
	await h.emit("agent_end", { messages: [assistant({ output: 99 })] });
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 0);
	assert.equal(h.continuations().length, count + 2);
});

test("uncached assistant usage accumulates until the budget stops continuation and shows a message", async () => {
	const h = harness({ hasUI: true });
	await h.tool("create_goal", { objective: "Budgeted work", token_budget: 30 });
	await h.emit("agent_start");
	await h.emit("agent_end", {
		messages: [
			{ role: "user", usage: { totalTokens: 999 } },
			assistant({ input: 100, cacheRead: 90, output: 5, totalTokens: 105 }),
			assistant({ input: -2, output: -3, totalTokens: 4 }),
			{ role: "assistant", stopReason: "stop" },
		],
	});
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 19);
	assert.equal(h.continuations().length, 1);
	await h.emit("agent_start");
	await h.emit("agent_end", { messages: [assistant({ input: 4, cacheRead: 9, output: 11 })] });
	const result = await h.tool("get_goal");
	assert.equal(result.goal.tokensUsed, 30);
	assert.equal(result.goal.status, "budgetLimited");
	assert.equal(result.remainingTokens, 0);
	assert.equal(h.continuations().length, 1);
	assert.equal(h.branch.at(-1).data.goal.status, "budgetLimited");
	assert.match(h.uiMessages().at(-1).message.content, /reached its token budget/);
	assert.deepEqual(h.uiMessages().at(-1).options, { triggerTurn: false });
	assert.equal(h.statuses.at(-1).text, "Goal budget reached");
});

for (const [errorMessage, status] of [
	["USAGE exhausted", "usageLimited"],
	["Rate exceeded", "usageLimited"],
	["quota reached", "usageLimited"],
	["token limit reached", "usageLimited"],
	["Network disconnected", "blocked"],
	["prorated unlimited quotas", "blocked"],
	[undefined, "blocked"],
]) {
	test(`last assistant error ${JSON.stringify(errorMessage)} stops the goal as ${status}`, async () => {
		const h = harness();
		await h.tool("create_goal", { objective: "Work until stopped" });
		await h.emit("agent_start");
		await h.emit("agent_end", {
			messages: [
				assistant({}, { stopReason: "error", errorMessage: "Earlier quota error" }),
				assistant({ output: 3 }, { stopReason: "error", errorMessage }),
				{ role: "toolResult", content: [] },
			],
		});
		assert.equal((await h.tool("get_goal")).goal.status, status);
		assert.equal((await h.tool("get_goal")).goal.tokensUsed, 3);
		assert.equal(h.branch.at(-1).data.action, "status");
		assert.equal(h.branch.at(-1).data.goal.status, status);
		assert.equal(h.continuations().length, 0);
		assert.match(h.uiMessages().at(-1).message.content, /last goal turn ended with an error/);
	});
}

test("an earlier error does not stop a successful last assistant turn", async () => {
	const h = harness();
	await h.tool("create_goal", { objective: "Recover from an error" });
	await h.emit("agent_start");
	await h.emit("agent_end", {
		messages: [assistant({}, { stopReason: "error", errorMessage: "quota" }), assistant()],
	});
	assert.equal((await h.tool("get_goal")).goal.status, "active");
	assert.equal(h.continuations().length, 1);
});

for (const [hasUI, confirm, expectedStatus] of [
	[false, true, "paused"],
	[true, true, "paused"],
	[true, false, "active"],
]) {
	test(`aborted turn with hasUI=${hasUI}, confirm=${confirm} leaves goal ${expectedStatus}`, async () => {
		const h = harness({ hasUI, confirm });
		await h.tool("create_goal", { objective: "Handle abort" });
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant({ output: 2 }, { stopReason: "aborted" })] });
		assert.equal((await h.tool("get_goal")).goal.status, expectedStatus);
		assert.equal((await h.tool("get_goal")).goal.tokensUsed, 2);
		assert.equal(h.confirmations.length, hasUI ? 1 : 0);

		if (hasUI) assert.equal(h.confirmations[0][0], "Pause active goal?");
		assert.equal(h.continuations().length, expectedStatus === "active" ? 1 : 0);
		assert.equal(h.uiMessages().length, hasUI && confirm ? 1 : 0);
		assert.equal(h.branch.at(-1).data.goal.status, expectedStatus);
	});
}

test("elapsed time counts active intervals, preserves fractional seconds, and excludes pauses", async (t) => {
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const h = harness();
	await h.tool("create_goal", { objective: "Timed work" });
	now += 2_500;
	assert.equal((await h.tool("get_goal")).goal.timeUsedSeconds, 2);
	await h.emit("agent_start");
	await h.emit("agent_end", { messages: [assistant()] });
	assert.equal(h.branch.at(-1).data.goal.timeUsedSeconds, 2);
	now += 500;
	await h.command("pause");
	assert.equal((await h.tool("get_goal")).goal.timeUsedSeconds, 3);
	now += 60_000;
	assert.equal((await h.tool("get_goal")).goal.timeUsedSeconds, 3);
	await h.command("resume");
	now += 4_000;
	await h.tool("update_goal", { status: "complete" });
	now += 60_000;
	assert.equal((await h.tool("get_goal")).goal.timeUsedSeconds, 7);
	assert.equal(h.branch.at(-1).data.goal.timeUsedSeconds, 7);
});

for (const event of ["session_start", "session_tree"]) {
	for (const [storedStatus, status] of [
		["active", "active"],
		["paused", "paused"],
		["blocked", "blocked"],
		["complete", "complete"],
		["usageLimited", "usageLimited"],
		["budgetLimited", "budgetLimited"],
		["usage_limited", "usageLimited"],
		["budget_limited", "budgetLimited"],
	]) {
		test(`${event} restores persisted ${storedStatus} as ${status}`, async (t) => {
			let now = 1_000_000;
			t.mock.method(Date, "now", () => now);
			const entry = storedGoal(storedStatus);
			const h = harness({ branch: [storedGoal("complete", { objective: "Old goal" }), entry] });
			await h.emit(event);
			now += 2_000;
			assert.deepEqual((await h.tool("get_goal")).goal, {
				threadId: "goal-test",
				objective: entry.data.goal.objective,
				status,
				tokenBudget: 100,
				tokensUsed: 12,
				timeUsedSeconds: status === "active" ? 9 : 7,
				createdAt: 100,
				updatedAt: 110,
			});
			await h.emit("agent_start");
			await h.emit("agent_end", { messages: [assistant({ output: 3 })] });
			assert.equal((await h.tool("get_goal")).goal.tokensUsed, status === "active" ? 15 : 12);
			assert.equal(h.continuations().length, status === "active" ? 1 : 0);

			if (status === "active") {
				assert.equal(h.continuations()[0].message.details.goalId, "persisted-goal");
			}
		});
	}
}

test("session tree navigation resets in-flight bookkeeping and honors cleared branch state", async () => {
	const h = harness();
	await h.command("Original branch");
	await h.emit("agent_start");
	h.branch.push(storedGoal());
	await h.emit("session_tree");
	await h.emit("agent_end", { messages: [assistant({ output: 50 })] });
	assert.equal((await h.tool("get_goal")).goal.tokensUsed, 12);
	assert.equal(h.continuations().length, 2);
	h.branch.push({ type: "custom", customType: "goal", data: { version: 2, action: "clear", goal: null } });
	await h.emit("session_tree");
	assert.equal((await h.tool("get_goal")).goal, null);
	await h.emit("agent_start");
	await h.emit("agent_end", { messages: [assistant()] });
	assert.equal(h.continuations().length, 2);
	h.branch.length = 0;
	await h.emit("session_start");
	assert.equal((await h.tool("get_goal")).goal, null);
});

test("a fresh extension reconstructs state persisted by tools and commands", async () => {
	const original = harness();
	await original.tool("create_goal", { objective: "Persist actual state", token_budget: 200 });
	await original.emit("agent_start");
	await original.emit("agent_end", { messages: [assistant({ output: 17 })] });
	await original.command("pause");
	const restored = harness({ branch: original.branch });
	await restored.emit("session_start");
	assert.deepEqual(await restored.tool("get_goal"), await original.tool("get_goal"));
	await restored.command("resume");
	assert.equal(restored.continuations().length, 1);
});

test("context drops goal UI messages but preserves continuation messages and their identity", async () => {
	const h = harness();
	await h.command("Keep cached continuation context");
	const user = { role: "user", content: "Start" };
	const unrelated = { role: "custom", customType: "other-extension", content: "Keep me" };
	const continuation = h.continuations()[0].message;
	const reply = assistant();
	const messages = [user, h.uiMessages()[0].message, continuation, unrelated, reply];
	const result = await h.emit("context", { messages });
	assert.deepEqual(result.messages, [user, continuation, unrelated, reply]);
	assert.equal(result.messages[1], continuation);
	assert.equal(messages.length, 5);
});
