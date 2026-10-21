import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openOverlay } from "../../extensions/btw/overlay.ts";

export default function overlayFixture(pi: ExtensionAPI) {
	pi.registerCommand("overlay-render-test", {
		description: "Exercise the real shared overlay renderer without network or an interactive terminal.",
		handler: async (_args, ctx) => {
			let cases = 0;
			const failures: string[] = [];

			for (const text of [
				"**Assistant:** Verify the backup first.",
				"**You:** Explain.\n\n**Assistant:** Short answer.\n\nAnother paragraph.",
				"**Assistant:** 日本語 🙂 café\n\n```sh\necho dry-run\n```\n\n" + "A long wrapped response. ".repeat(30),
			]) {
				let transcript = text;
				const submitted: string[] = [];

				// SAFETY: openOverlay requests custom<void>; this fixture supplies its complete render-only UI surface.
				const fake = {
					...ctx,
					ui: {
						...ctx.ui,
						custom: async (factory) => {
							try {
								const component = factory(
									{ terminal: { rows: 30 }, requestRender() {} },
									ctx.ui.theme,
									{ matches: () => false },
									() => {},
								);

								for (const width of [3, 12, 43, 90, 118]) {
									const rows = component.render(width);

									for (const [index, row] of rows.entries()) {
										assert.equal(visibleWidth(row), width, `row ${index} must fully cover its overlay width ${width}`);
										const plain = stripVTControlCharacters(row);

										if (index > 0 && index < rows.length - 1) {
											assert.ok(
												plain.startsWith("│") && plain.endsWith("│"),
												`body row ${index} needs both borders: ${plain}`,
											);
										}
									}

									cases++;
								}

								transcript = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`).join("\n");
								const render = () => component.render(118).map(stripVTControlCharacters).join("\n");
								assert.match(render(), /TYPING.*Following latest/);
								component.handleInput("draft jk");
								component.handleInput("\t");
								component.handleInput("g");
								assert.match(render(), /READING \| 1-19\/80 \| Paused/);
								component.handleInput("j");
								assert.match(render(), /READING \| 2-20\/80/);
								component.handleInput("\u001b[A");
								assert.match(render(), /READING \| 1-19\/80/);
								transcript += "\nNew streamed line";
								assert.match(render(), /READING \| 1-19\/81 \| Paused/);
								component.handleInput("G");
								assert.match(render(), /READING \| 63-81\/81 \| Following latest/);
								component.handleInput("\t");
								assert.match(render(), /> draft jk/);
								component.handleInput("\r");
								assert.deepEqual(submitted, ["draft jk"]);
							} catch (error) {
								failures.push(error instanceof Error ? error.message : String(error));
							}
						},
					},
				} as ExtensionCommandContext;

				openOverlay(fake, {
					title: "BTW",
					text: () => transcript,
					status: () => "Ready",
					submit: (question) => submitted.push(question),
					cancel() {},
				});
				// openOverlay intentionally sanitizes UI errors; assert that each render completed too.
			}

			pi.appendEntry("btw-overlay-proof", { cases, failures });
		},
	});
}
