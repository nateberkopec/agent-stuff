/**
 * Vendored from mitsuhiko/agent-stuff extensions/answer.ts at 0865c849befd2021490679f96a8dee58c84ac857.
 * Licensed under Apache-2.0; see MITSUHIKO-AGENT-STUFF-LICENSE.txt.
 */

/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { parseJsonWithRepair, type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, defineTool } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { Type } from "typebox";
import { Value } from "typebox/value";

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type ExtractionOutcome =
	| { status: "ok"; result: ExtractionResult }
	| { status: "cancelled" }
	| { status: "error"; message: string };

const SYSTEM_PROMPT = `You are a question extractor. Given assistant messages in chronological order since the user's last reply, extract the questions that still need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Copy each complete question block verbatim into question, including its title, explanatory paragraphs, all choices, and any recommendation
- Never summarize, shorten, rephrase, or omit parts of a question block
- Later status updates may refer to earlier questions; extract the actual earlier questions, not the references
- If a later message replaces a question or round, use its replacement instead
- Never invent a question or put a missing-text explanation into the questions array
- Include context only for essential information outside the question block, copied verbatim
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

const CODEX_MODEL_IDS = ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.3-codex"];

const HAIKU_MODEL_ID = "claude-haiku-4-5";

/**
 * Prefer a fast configured Codex model for extraction, then haiku, then the
 * current model.
 */
async function selectExtractionModel(currentModel: Model<Api>, modelRegistry: ModelRegistry): Promise<Model<Api>> {
	for (const modelId of CODEX_MODEL_IDS) {
		const codexModel = modelRegistry.find("openai-codex", modelId);

		if (codexModel) {
			const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);

			if (auth.ok) {
				return codexModel;
			}
		}
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);

	if (!haikuModel) {
		return currentModel;
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);

	if (auth.ok === false) {
		return currentModel;
	}

	return haikuModel;
}

const ExtractedQuestions = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String(),
			context: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
	),
});

/**
 * Parse the JSON response from the LLM.
 */
function parseExtractionResult(text: string): ExtractionResult | null {
	const candidates: string[] = [];
	const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);

	if (jsonMatch) {
		candidates.push(jsonMatch[1].trim());
	}

	const trimmed = text.trim();
	candidates.push(trimmed);

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");

	if (firstBrace !== -1 && lastBrace > firstBrace) {
		candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of candidates) {
		try {
			const result = parseJsonWithRepair<unknown>(candidate);

			if (Value.Check(ExtractedQuestions, result)) {
				return {
					questions: result.questions.map(({ question, context }) => (context ? { question, context } : { question })),
				};
			}
		} catch {
			// Try the next candidate.
		}
	}

	return null;
}

function restoreQuestionBlock(question: ExtractedQuestion, assistantTexts: string[]): ExtractedQuestion {
	for (const text of assistantTexts.toReversed()) {
		const headings = [...text.matchAll(/^(?:❓\s*)?(?:\*\*)?Q\d+\b[^\n]*/gm)];

		for (let i = 0; i < headings.length; i++) {
			const block = text.slice(headings[i].index, headings[i + 1]?.index ?? text.length).trim();

			if (block.includes(question.question)) {
				if (question.context && !block.includes(question.context)) {
					return { question: block, context: question.context };
				}

				return { question: block };
			}
		}
	}

	return question;
}

const OTHER_ANSWER = "Other (type an answer)";

function questionChoices(question: string): string[] {
	const inline = question.match(/\bChoices:[ \t]*([^\n]*)/i);
	const bullets = question.match(/\bChoices:[ \t]*\n((?:[ \t]*[-*][ \t]+[^\n]+\n?)+)/i);
	const listed = bullets?.[1] ?? question;

	const pattern = bullets ? /^[ \t]*[-*][ \t]+(.+)$/gm : /^\s*(?:\d+[.)]|[A-Za-z][.)]|\(\d+\)|\([A-Za-z]\))\s+(.+)$/gm;

	const choices =
		inline && /[/,]/.test(inline[1])
			? inline[1].split(/[/,]/).map((choice) => choice.trim())
			: [...listed.matchAll(pattern)].map((match) => match[1].trim());

	const unique = [...new Set(choices.filter(Boolean))];

	return unique.length >= 2 ? unique : [];
}

function formatAnswers(questions: ExtractedQuestion[], answers: string[]): string {
	return questions
		.map((question, index) => {
			const context = question.context ? `\n> ${question.context}` : "";

			return `Q: ${question.question}${context}\nA: ${answers[index]?.trim() || "(no answer)"}`;
		})
		.join("\n\n");
}

async function askWithDialogs(
	questions: ExtractedQuestion[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string | null> {
	const answers: string[] = [];

	for (const question of questions) {
		if (signal?.aborted) return null;
		const title = question.context ? `${question.question}\n\n${question.context}` : question.question;
		const choices = questionChoices(question.question);
		let answer: string | undefined;

		if (choices.length > 0) {
			answer = await ctx.ui.select(title, [...choices.filter((choice) => choice !== OTHER_ANSWER), OTHER_ANSWER], {
				signal,
			});
		}

		if (choices.length === 0 || answer === OTHER_ANSWER) {
			if (signal?.aborted) return null;
			answer = await ctx.ui.input(title, "Type your answer", { signal });
		}

		if (answer === undefined || signal?.aborted) return null;
		answers.push(answer);
	}

	return formatAnswers(questions, answers);
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors - using proper reset sequences
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: string | null) => void) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: (s: string) => `\x1b[44m${s}\x1b[0m`,
				description: this.gray,
				scrollInfo: this.dim,
				noMatch: this.yellow,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private allQuestionsAnswered(): boolean {
		this.saveCurrentAnswer();

		return this.answers.every((a) => (a?.trim() || "").length > 0);
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		this.onDone(formatAnswers(this.questions, this.answers));
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();

				return;
			}

			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();

				return;
			}

			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();

			return;
		}

		// Tab / Shift+Tab for navigation
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}

			return;
		}

		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}

			return;
		}

		// Arrow up/down for question navigation when editor is empty
		// (Editor handles its own cursor navigation when there's content)
		if (matchesKey(data, Key.up) && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();

				return;
			}
		}

		if (matchesKey(data, Key.down) && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();

				return;
			}
		}

		// Handle Enter ourselves (editor's submit is disabled)
		// Plain Enter moves to next question or shows confirmation on last question
		// Shift+Enter adds a newline (handled by editor)
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();

			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				// On last question - show confirmation
				this.showingConfirmation = true;
			}

			this.invalidate();
			this.tui.requestRender();

			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);

			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);

			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
		const progressParts: string[] = [];

		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;

			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}

		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current question
		const q = this.questions[this.currentIndex];
		const questionText = `${this.bold("Q:")} ${q.question}`;
		const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);

		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.gray(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);

			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Render the editor component (multi-line input) with padding
		// Skip the first and last lines (editor's own border lines)
		const answerPrefix = this.bold("A: ");
		const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
		const editorLines = this.editor.render(editorWidth);

		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				// First content line gets the "A: " prefix
				lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			} else {
				// Subsequent lines get padding to align with the first line
				lines.push(padToWidth(boxLine("   " + editorLines[i])));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}

		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "answer",
			label: "Answer questions",
			description:
				"Collect the user's answers in an interactive Q&A screen. Use for each grilling question round. Supply complete question text, choices, and recommendations; write choices as Choices: A / B / C or numbered/lettered lines. The user's answers are returned directly. If cancelled, stop the interview until the user asks to resume.",
			exposure: "model-only",
			parameters: Type.Object({
				questions: Type.Array(
					Type.Object({
						question: Type.String({
							minLength: 1,
							description: "Complete question, including title, explanation, and choices.",
						}),
						context: Type.Optional(Type.String({ description: "Supporting context or your recommended answer." })),
					}),
					{ minItems: 1 },
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (!ctx.hasUI) {
					throw new Error("answer requires a UI; ask the questions in chat instead.");
				}

				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Cancelled. Wait for the user to resume." }],
						details: { cancelled: true },
						terminate: true,
					};
				}

				let abortHandler: (() => void) | undefined;
				let answers: string | null;

				try {
					answers =
						ctx.mode !== "tui"
							? await askWithDialogs(params.questions, ctx, signal)
							: await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
									abortHandler = () => done(null);
									signal?.addEventListener("abort", abortHandler, { once: true });

									if (signal?.aborted) done(null);

									return new QnAComponent(params.questions, tui, done);
								});
				} finally {
					if (abortHandler) signal?.removeEventListener("abort", abortHandler);
				}

				if (answers === null) {
					return {
						content: [{ type: "text", text: "Cancelled. Wait for the user to resume." }],
						details: { cancelled: true },
						terminate: true,
					};
				}

				return {
					content: [{ type: "text", text: "The user answered your questions:\n\n" + answers }],
					details: { cancelled: false, answers },
				};
			},
		}),
	);

	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");

			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");

			return;
		}

		const branch = ctx.sessionManager.getBranch();
		const assistantTexts: string[] = [];

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];

			if (entry.type === "message") {
				const msg = entry.message;

				if (msg.role === "user" || (msg.role === "custom" && msg.customType === "answers")) {
					break;
				}

				if (msg.role === "assistant") {
					if (assistantTexts.length === 0 && msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");

						return;
					}

					const textParts = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);

					if (textParts.length > 0 && msg.stopReason === "stop") {
						assistantTexts.unshift(textParts.join("\n"));
					}
				}
			}
		}

		if (assistantTexts.length === 0) {
			ctx.ui.notify("No assistant messages since your last reply", "info");

			return;
		}

		// Select the best model for extraction.
		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

		// Run extraction with loader UI
		const extractionOutcome = await ctx.ui.custom<ExtractionOutcome>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
			loader.onAbort = () => done({ status: "cancelled" });

			const doExtract = async (): Promise<ExtractionOutcome> => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);

				if (auth.ok === false) {
					return { status: "error", message: auth.error };
				}

				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: assistantTexts.join("\n\n--- Next assistant message ---\n\n") }],
					timestamp: Date.now(),
				};

				const response = await ctx.modelRegistry
					.streamSimple(
						extractionModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					)
					.result();

				if (response.stopReason === "aborted") {
					return { status: "cancelled" };
				}

				if (response.stopReason === "error") {
					return { status: "error", message: response.errorMessage ?? "question extraction failed" };
				}

				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				const result = parseExtractionResult(responseText);

				if (!result) {
					return { status: "error", message: "question extraction returned invalid JSON" };
				}

				if (
					result.questions.some(
						(q) =>
							!q.question.trim() ||
							!assistantTexts.some((text) => text.includes(q.question)) ||
							(q.context && !assistantTexts.some((text) => text.includes(q.context!))),
					)
				) {
					return { status: "error", message: "question extraction did not preserve the original text" };
				}

				return {
					status: "ok",
					result: {
						questions: result.questions.map((question) => restoreQuestionBlock(question, assistantTexts)),
					},
				};
			};

			doExtract()
				.then(done)
				.catch((cause: unknown) => {
					const message = cause instanceof Error ? cause.message : String(cause);
					done({ status: "error", message });
				});

			return loader;
		});

		if (extractionOutcome.status === "cancelled") {
			ctx.ui.notify("Cancelled", "info");

			return;
		}

		if (extractionOutcome.status === "error") {
			ctx.ui.notify(`Question extraction failed: ${extractionOutcome.message}`, "error");

			return;
		}

		const extractionResult = extractionOutcome.result;

		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No unanswered questions found since your last reply", "info");

			return;
		}

		// Show the Q&A component
		const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
			return new QnAComponent(extractionResult.questions, tui, done);
		});

		if (answersResult === null) {
			ctx.ui.notify("Cancelled", "info");

			return;
		}

		// Send the answers directly as a message and trigger a turn
		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract pending questions into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer pending questions",
		handler: answerHandler,
	});
}
