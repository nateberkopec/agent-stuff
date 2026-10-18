import { registerHooks } from "node:module";

const parentURL = new URL("../../development/package.json", import.meta.url).href;

const packages = new Set([
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-coding-agent",
	"typebox",
]);

registerHooks({
	resolve: (specifier, context, next) => next(specifier, packages.has(specifier) ? { ...context, parentURL } : context),
});
