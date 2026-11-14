import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import bashTimeout from "../extensions/bash_timeout.ts";

async function runBash(t, args) {
	const dir = mkdtempSync(path.join(tmpdir(), "bash-timeout-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const faux = fauxProvider();
	const executed = [];

	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		extensionFactories: [
			(pi) => pi.registerProvider(faux.provider),
			bashTimeout,
			(pi) => pi.on("tool_call", (event) => void executed.push(event.input.timeout)),
		],
	});

	await loader.reload();

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		tools: ["bash"],
		model: faux.getModel(),
	});

	faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", args)), fauxAssistantMessage("done")]);
	await session.prompt("go");

	const result = session.messages.find((message) => message.role === "toolResult");

	return { timeout: executed[0], text: result.content.map((block) => block.text) };
}

test("a bash call without a timeout runs with 10s and tells the model", async (t) => {
	const { timeout, text } = await runBash(t, { command: "echo hi" });

	assert.equal(timeout, 10);
	assert.deepEqual(text, [
		"<system-reminder>This bash call omitted `timeout`, so the harness applied a default of 10s.</system-reminder>",
		"hi\n",
	]);
});

test("an explicit bash timeout is left alone without a reminder", async (t) => {
	const { timeout, text } = await runBash(t, { command: "echo hi", timeout: 300 });

	assert.equal(timeout, 300);
	assert.deepEqual(text, ["hi\n"]);
});

test("a find call without a timeout runs with 2s and reports 2s", async (t) => {
	const { timeout, text } = await runBash(t, { command: "find . -maxdepth 0" });

	assert.equal(timeout, 2);
	assert.deepEqual(text, [
		"<system-reminder>This bash call omitted `timeout`, so the harness applied a default of 2s.</system-reminder>",
		".\n",
	]);
});
