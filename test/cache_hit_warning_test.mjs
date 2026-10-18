import assert from "node:assert/strict";
import { test } from "node:test";
import cacheHitWarning from "../extensions/cache_hit_warning.ts";

function assistant(cacheRead = 0, input = 100, cacheWrite = 0) {
	return { type: "message", message: { role: "assistant", usage: { input, cacheRead, cacheWrite } } };
}

function harness(branch = [], entries = branch) {
	const handlers = new Map();
	let status;

	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => branch, getEntries: () => entries },
		ui: {
			setStatus(key, text) {
				assert.equal(key, "cache-hit-warning");
				status = text;
			},
			theme: { bold: (text) => text, fg: (_color, text) => text },
		},
	};

	cacheHitWarning({ on: (name, handler) => handlers.set(name, handler) });

	return {
		branch,
		ctx,
		get status() {
			return status;
		},
		async emit(name, event = {}) {
			await handlers.get(name)(event, ctx);
		},
		async response(entry = assistant()) {
			await this.emit("message_end", { message: entry.message });
			branch.push(entry);
		},
	};
}

test("restores only the active branch after session_tree", async () => {
	const branch = [assistant(), assistant()];
	const h = harness(branch, [...branch, assistant(100, 0)]);
	await h.emit("session_start");
	assert.equal(h.status, "[ CH WARNING ]");
	h.branch.splice(0, h.branch.length, assistant(), assistant(100, 0));
	await h.emit("session_tree");
	assert.equal(h.status, undefined);
	h.branch.splice(0, h.branch.length, assistant(), assistant());
	await h.emit("session_tree");
	assert.equal(h.status, "[ CH WARNING ]");
	h.branch.length = 0;
	await h.emit("session_tree");
	assert.equal(h.status, undefined);
});

test("suppresses the first assistant turn live and on restore", async () => {
	const h = harness([{ type: "message", message: { role: "user" } }]);
	await h.emit("session_start");
	assert.equal(h.status, undefined);
	await h.response();
	assert.equal(h.status, undefined);
	await h.emit("session_start");
	assert.equal(h.status, undefined);
	await h.response();
	assert.equal(h.status, "[ CH WARNING ]");
});

test("suppresses the first assistant turn after compaction live and on restore", async () => {
	const h = harness([assistant(), assistant()]);
	await h.emit("session_start");
	assert.equal(h.status, "[ CH WARNING ]");
	h.branch.push({ type: "compaction", summary: "Compacted history" });
	await h.emit("session_start");
	assert.equal(h.status, undefined);
	h.branch.push({ type: "message", message: { role: "user" } });
	await h.response();
	assert.equal(h.status, undefined);
	await h.emit("session_tree");
	assert.equal(h.status, undefined);
	await h.response();
	assert.equal(h.status, "[ CH WARNING ]");
	await h.emit("session_start");
	assert.equal(h.status, "[ CH WARNING ]");
});

test("keeps the 95 percent threshold and counts cache writes as prompt tokens", async () => {
	const h = harness([assistant()]);
	await h.response(assistant(94, 6));
	assert.equal(h.status, "[ CH WARNING ]");
	await h.response(assistant(95, 5));
	assert.equal(h.status, undefined);
	await h.response(assistant(95, 0, 6));
	assert.equal(h.status, "[ CH WARNING ]");
	await h.response(assistant(0, 0));
	assert.equal(h.status, undefined);
});

test("ignores non-assistant message_end and clears on session_shutdown", async () => {
	const h = harness([assistant(), assistant()]);
	await h.emit("session_start");
	assert.equal(h.status, "[ CH WARNING ]");
	await h.emit("message_end", { message: { role: "toolResult" } });
	assert.equal(h.status, "[ CH WARNING ]");
	await h.emit("session_shutdown");
	assert.equal(h.status, undefined);
});

test("does not update status without a UI", async () => {
	const h = harness([assistant(), assistant()]);
	h.ctx.hasUI = false;
	await h.emit("session_start");
	await h.response();
	assert.equal(h.status, undefined);
});
