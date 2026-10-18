// Vendored from https://github.com/forlorn-echo/pi-caffeinate at
// 3a7629bd3bb119cea6f428e1fca751c4f7089934 (MIT, Copyright (c) 2026 Abhishek Sinha).
// Vendored as a local file (instead of a Pi package) so Linux/Ubuntu convergence
// never executes the upstream macOS-only preinstall check.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { subagentsRunning } from "./notify/readiness.ts";

const CAFFEINATE_COMMAND = "caffeinate";

const ASSERTION_TIMEOUT_SECONDS = 300;

const REFRESH_INTERVAL_MS = 4 * 60 * 1_000;

const RETRY_INTERVAL_MS = 5_000;

const RELEASE_DELAY_MS = 30_000;

export default function piCaffeinate(pi: ExtensionAPI) {
	if (process.platform !== "darwin") return;

	const probe = spawnSync(CAFFEINATE_COMMAND, ["-h"], { stdio: "ignore" });

	if (probe.error) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-caffeinate is disabled: required command is not available on PATH: ${CAFFEINATE_COMMAND}`,
					"warning",
				);
			}
		});

		return;
	}

	let active = false;
	let agentActive = false;
	let shuttingDown = false;
	let generation = 0;
	let currentContext: ExtensionContext | undefined;
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	let assertion: ChildProcess | undefined;
	let pendingAssertion: ChildProcess | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let errorNotified = false;

	const clearTimers = () => {
		if (refreshTimer) clearTimeout(refreshTimer);

		if (retryTimer) clearTimeout(retryTimer);

		if (releaseTimer) clearTimeout(releaseTimer);
		refreshTimer = undefined;
		retryTimer = undefined;
		releaseTimer = undefined;
	};

	const scheduleRefresh = (ctx: ExtensionContext) => {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			launchAssertion(ctx);
			void reconcile(ctx);
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	};

	const scheduleRetry = (ctx: ExtensionContext) => {
		if (!active || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			launchAssertion(ctx);
		}, RETRY_INTERVAL_MS);
		retryTimer.unref?.();
	};

	const launchAssertion = (ctx: ExtensionContext) => {
		if (!active || pendingAssertion) return;

		const candidate = spawn(CAFFEINATE_COMMAND, ["-i", "-t", String(ASSERTION_TIMEOUT_SECONDS)], {
			stdio: "ignore",
		});

		pendingAssertion = candidate;

		candidate.once("spawn", () => {
			if (pendingAssertion === candidate) pendingAssertion = undefined;

			if (!active) {
				candidate.kill("SIGTERM");

				return;
			}

			const previous = assertion;
			assertion = candidate;
			previous?.kill("SIGTERM");
			errorNotified = false;
			scheduleRefresh(ctx);
		});

		candidate.once("error", (error) => {
			if (pendingAssertion === candidate) pendingAssertion = undefined;

			if (assertion === candidate) assertion = undefined;

			if (!errorNotified && ctx.hasUI) {
				errorNotified = true;
				ctx.ui.notify(`Unable to prevent macOS sleep: ${error.message}`, "warning");
			}

			scheduleRetry(ctx);
		});

		candidate.once("exit", () => {
			if (pendingAssertion === candidate) pendingAssertion = undefined;

			if (assertion !== candidate) return;
			assertion = undefined;

			if (refreshTimer) clearTimeout(refreshTimer);
			refreshTimer = undefined;
			scheduleRetry(ctx);
		});
	};

	const start = (ctx: ExtensionContext) => {
		if (releaseTimer) clearTimeout(releaseTimer);
		releaseTimer = undefined;
		active = true;

		if (!assertion && !pendingAssertion) launchAssertion(ctx);
	};

	const stop = () => {
		active = false;
		clearTimers();
		pendingAssertion?.kill("SIGTERM");
		assertion?.kill("SIGTERM");
		pendingAssertion = undefined;
		assertion = undefined;
	};

	const reconcile = async (ctx: ExtensionContext, release = false) => {
		if (shuttingDown) return;

		const requestGeneration = ++generation;

		if (agentActive) {
			start(ctx);

			return;
		}

		const backgroundActive = await subagentsRunning(pi);

		if (shuttingDown || requestGeneration !== generation) return;

		if (backgroundActive) {
			start(ctx);

			return;
		}

		if (!active) return;

		if (release) {
			stop();

			return;
		}

		if (releaseTimer) return;

		releaseTimer = setTimeout(() => {
			releaseTimer = undefined;
			void reconcile(ctx, true);
		}, RELEASE_DELAY_MS);
		releaseTimer.unref?.();
	};

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		currentContext = ctx;
		void reconcile(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		generation += 1;
		agentActive = true;
		currentContext = ctx;
		start(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		agentActive = false;
		void reconcile(ctx);
	});

	const unsubscribes = ["subagent:async-started", "subagent:async-complete", "subagent:process-terminal"].map(
		(channel) =>
			pi.events.on(channel, () => {
				if (!currentContext || shuttingDown) return;

				if (channel === "subagent:async-started") start(currentContext);

				void reconcile(currentContext);
			}),
	);

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		agentActive = false;
		generation += 1;
		stop();

		for (const unsubscribe of unsubscribes) unsubscribe();
	});
}
