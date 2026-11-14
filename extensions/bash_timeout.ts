import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const FIND_COMMAND_PATTERN = /(?:^|&&|\|\||[;|\n(])\s*(?:command\s+)?(?:sudo\s+)?find(?:\s|$)/;

const MAX_FIND_TIMEOUT_SECONDS = 2;

const DEFAULT_TIMEOUT_SECONDS = 10;

function hasFindCommand(command: string): boolean {
	return FIND_COMMAND_PATTERN.test(command);
}

function validFindTimeout(timeout: number | undefined): boolean {
	return Value.Check(Type.Number({ exclusiveMinimum: 0, maximum: MAX_FIND_TIMEOUT_SECONDS }), timeout);
}

function reminder(timeout: number): string {
	return `<system-reminder>This bash call omitted \`timeout\`, so the harness applied a default of ${timeout}s.</system-reminder>`;
}

export default function bashTimeoutExtension(pi: ExtensionAPI) {
	const defaulted = new Map<string, number>();

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;

		const find = hasFindCommand(event.input.command);

		if (event.input.timeout === undefined && !event.parentToolCallId) {
			const timeout = find ? MAX_FIND_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS;
			event.input.timeout = timeout;
			defaulted.set(event.toolCallId, timeout);

			return undefined;
		}

		if (find && !validFindTimeout(event.input.timeout)) event.input.timeout = MAX_FIND_TIMEOUT_SECONDS;

		return undefined;
	});

	pi.on("tool_result", async (event) => {
		const timeout = defaulted.get(event.toolCallId);

		if (timeout === undefined) return undefined;

		defaulted.delete(event.toolCallId);

		return { content: [{ type: "text", text: reminder(timeout) }, ...event.content] };
	});
}
