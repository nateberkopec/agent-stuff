import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

let response;

let requestOptions;

registerHooks({
	resolve(specifier, context, nextResolve) {
		const source = specifier === "@earendil-works/pi-ai" ? 'export const uuidv7 = () => "test-session";' : undefined;

		return source
			? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
			: nextResolve(specifier, context);
	},
});

const { default: conversationTitle } = await import("../extensions/conversation_title.ts");

async function settle(result, headers) {
	response = result;
	const handlers = new Map();
	const entries = [];
	const titles = [];
	const warnings = [];
	conversationTitle({
		on(name, handler) {
			handlers.set(name, handler);
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
	});

	const ctx = {
		mode: "tui",
		model: { provider: "openai", id: "gpt-6.1-sol" },
		modelRegistry: {
			streamSimple(_model, _context, options) {
				requestOptions = options;

				return { result: async () => response };
			},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "test-key", headers };
			},
		},
		sessionManager: {
			getBranch() {
				return [{ type: "message", message: { role: "user", content: "Fix notification banners" } }];
			},
		},
		ui: {
			setTitle(title) {
				titles.push(title);
			},
		},
	};

	const originalWarn = console.warn;
	console.warn = (message) => warnings.push(message);

	try {
		await handlers.get("agent_settled")({}, ctx);
	} finally {
		console.warn = originalWarn;
		handlers.get("session_shutdown")({}, ctx);
	}

	return { entries, titles, warnings };
}

test("generates and saves a title using reasoning supported by the session model", async () => {
	const { entries, titles, warnings } = await settle({
		stopReason: "stop",
		content: [{ type: "text", text: "Fix notification banners" }],
	});

	assert.equal(requestOptions.reasoning, "low");
	assert.equal(entries[0].type, "conversation-title");
	assert.equal(entries[0].data.title, "Fix notification banners");
	assert.equal(titles.at(-1), "π · Fix notification banners");
	assert.deepEqual(warnings, []);
});

test("routes title calls through the provider registry with a separate session identity", async () => {
	await settle(
		{ stopReason: "stop", content: [{ type: "text", text: "Fix notifications" }] },
		{
			"x-meridian-agent": "pi",
			"x-session-affinity": "parent",
			"x-meridian-profile": "work",
		},
	);
	assert.equal(requestOptions.sessionId, "test-session");
	assert.equal(requestOptions.headers["x-session-affinity"], "parent");
	assert.equal(requestOptions.headers["x-meridian-profile"], "work");
});

test("logs returned API errors instead of silently discarding them", async () => {
	const { entries, warnings } = await settle({
		stopReason: "error",
		errorMessage: "Unsupported reasoning effort",
		content: [],
	});

	assert.deepEqual(entries, []);
	assert.deepEqual(warnings, ["[conversation-title] Unsupported reasoning effort"]);
});

test("reports API errors even when the provider omits the error message", async () => {
	const { entries, warnings } = await settle({ stopReason: "error", content: [] });
	assert.deepEqual(entries, []);
	assert.deepEqual(warnings, ["[conversation-title] Title generation failed"]);
});
