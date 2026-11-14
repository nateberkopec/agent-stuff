import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = 10;

const REMINDER = `<system-reminder>This bash call omitted \`timeout\`, so the harness applied a default of ${DEFAULT_TIMEOUT_SECONDS}s.</system-reminder>`;

export default function bashTimeoutExtension(pi: ExtensionAPI) {
	const defaulted = new Set<string>();

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;

		if (event.input.timeout !== undefined || event.parentToolCallId) return undefined;

		event.input.timeout = DEFAULT_TIMEOUT_SECONDS;
		defaulted.add(event.toolCallId);

		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (!defaulted.delete(event.toolCallId)) return undefined;

		return { content: [{ type: "text", text: REMINDER }, ...event.content] };
	});
}
