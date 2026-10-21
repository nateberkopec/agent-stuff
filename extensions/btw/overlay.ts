// Adapted from Armin Ronacher's agent-stuff/extensions/btw.ts at 0865c849befd2021490679f96a8dee58c84ac857.
// Modified: configurable title, narrow sizing, native cursor handling, close without a dialog.
// Apache-2.0; see ../MITSUHIKO-AGENT-STUFF-LICENSE.txt.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Markdown,
	ScrollView,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Focusable,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

export interface ChatView {
	title: string;
	text: () => string;
	status: () => string;
	submit: (question: string) => void;
	cancel: () => void;
}

export function openOverlay(ctx: ExtensionContext, view: ChatView) {
	let refresh = () => {},
		close = () => {},
		closed = false;

	void ctx.ui
		.custom<void>(
			(tui, theme, keys, done) => {
				const input = new Input();
				const scroll = new ScrollView({ render: () => [], invalidate() {} }, { follow: "end" });
				let reading = false;
				let focused = true;

				const finish = () => {
					closed = true;
					done();
				};

				input.onSubmit = (text) => {
					if (text.trim()) {
						input.setValue("");
						view.submit(text.trim());
					}
				};

				input.onEscape = () => {
					view.cancel();
					finish();
				};

				const component: Focusable & {
					render: (width: number) => string[];
					invalidate: () => void;
					handleInput: (data: string) => void;
				} = {
					get focused() {
						return focused;
					},
					set focused(value) {
						focused = value;
						input.focused = value && !reading;
					},
					handleInput(data) {
						if (keys.matches(data, "tui.select.cancel")) {
							view.cancel();
							finish();
						} else if (matchesKey(data, "tab")) {
							reading = !reading;
							input.focused = focused && !reading;
							tui.requestRender();
						} else if (reading) {
							if (data === "k" || matchesKey(data, "up")) scroll.scrollBy(-1);
							else if (data === "j" || matchesKey(data, "down")) scroll.scrollBy(1);
							else if (data === "g") scroll.scrollTo(0, { disableFollow: true });
							else if (data === "G") scroll.scrollToEnd();
						} else input.handleInput(data);
					},
					render(width) {
						if (width < 3) return [truncateToWidth(view.title, Math.max(0, width), "")];

						const inner = Math.max(1, width - 2),
							border = (edge: "top" | "bottom") =>
								theme.fg(
									"borderMuted",
									`${edge === "top" ? "┌" : "└"}${"─".repeat(inner)}${edge === "top" ? "┐" : "┘"}`,
								);

						const line = (text: string) => {
							const clipped = truncateToWidth(text, inner, "");

							return `${theme.fg("borderMuted", "│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${theme.fg("borderMuted", "│")}`;
						};

						const height = Math.max(1, Math.floor((tui.terminal.rows ?? 30) * 0.9) - 8);
						const lines = new Markdown(view.text(), 0, 0, getMarkdownTheme()).render(inner);
						scroll.updateLayout(lines.length, height, () => tui.requestRender());
						const transcript = lines.slice(scroll.scrollTop, scroll.scrollTop + height);
						const position = `${scroll.scrollTop + 1}-${Math.min(lines.length, scroll.scrollTop + height)}/${lines.length}`;
						const mode = reading ? "READING" : "TYPING";

						return [
							border("top"),
							line(theme.fg("accent", theme.bold(view.title))),
							...transcript.map(line),
							line(
								theme.fg(
									"accent",
									`${mode} | ${position} | ${scroll.isFollowingEnd ? "Following latest" : "Paused"} | ${view.status()}`,
								),
							),
							line(
								reading
									? theme.fg("dim", input.getValue() || "Tab to type a follow-up")
									: (input.render(inner)[0] ?? ""),
							),
							line(
								theme.fg(
									"dim",
									reading
										? "Tab: type | j/k or arrows: scroll | g/G: top/bottom | Esc: close"
										: "Tab: read | Enter: send | Esc: close",
								),
							),
							border("bottom"),
						];
					},
					invalidate() {
						input.invalidate();
					},
				};

				component.focused = true;
				refresh = () => tui.requestRender();
				close = () => {
					view.cancel();
					finish();
				};

				if (closed) done();

				return component;
			},
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "top-center", margin: 1 } },
		)
		.catch(() => {
			closed = true;
			view.cancel();
			ctx.ui.notify("Side-chat UI failed.", "warning");
		});

	return {
		refresh: () => refresh(),
		close: () => {
			closed = true;
			close();
		},
		get closed() {
			return closed;
		},
	};
}
