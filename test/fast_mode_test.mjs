import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { configPaths, defaultResolvedConfig, resolveConfig } from "../extensions/fast-mode/index.ts";

test("reads global fast-mode config from PI_CODING_AGENT_DIR and preserves project overrides", (t) => {
	const root = mkdtempSync(join(tmpdir(), "fast-mode-"));
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = join(root, "home");
	const agentDir = join(root, "isolated-agent");
	const cwd = join(root, "project");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;

		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const globalPath = join(agentDir, "extensions", "pi-fast-mode.json");
	const projectPath = join(cwd, ".pi", "extensions", "pi-fast-mode.json");
	const homePath = join(home, ".pi", "agent", "extensions", "pi-fast-mode.json");

	for (const path of [globalPath, homePath]) mkdirSync(dirname(path), { recursive: true });

	writeFileSync(homePath, JSON.stringify({ active: false, serviceTier: "auto" }));
	writeFileSync(globalPath, JSON.stringify({ active: true, serviceTier: "priority", persistState: false }));

	assert.deepEqual(configPaths(cwd), { global: globalPath, project: projectPath });
	assert.equal(defaultResolvedConfig(cwd).configPath, globalPath);
	const globalConfig = resolveConfig(cwd);
	assert.equal(globalConfig.configPath, globalPath);
	assert.equal(globalConfig.active, true);
	assert.equal(globalConfig.serviceTier, "priority");
	assert.equal(globalConfig.persistState, false);

	mkdirSync(dirname(projectPath), { recursive: true });
	writeFileSync(projectPath, JSON.stringify({ active: false }));
	const projectConfig = resolveConfig(cwd);
	assert.equal(projectConfig.configPath, projectPath);
	assert.equal(projectConfig.active, false);
	assert.equal(projectConfig.serviceTier, "priority");
	assert.equal(projectConfig.persistState, false);
});
