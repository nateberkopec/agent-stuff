import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("./datasafe_harness.ts", import.meta.url));

const PI = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));

const FAKE_KEYS = {
	ANTHROPIC_API_KEY: "fake",
	OPENAI_API_KEY: "fake",
	OPENROUTER_API_KEY: "fake",
	BASETEN_API_KEY: "fake",
};

const AMBIENT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(
		([name]) => !/^(PI_|GOOGLE_|GCLOUD_|AWS_|AZURE_|ANTHROPIC_|OPENAI_)|_API_KEY$|_TOKEN$/.test(name),
	),
);

export function agent(t, files = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "datasafe-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = (name) => path.join(dir, name);

	const write = (name, value) => writeFileSync(file(name), JSON.stringify(value, null, 2));

	for (const [name, value] of Object.entries(files)) write(name, value);

	const log = () =>
		existsSync(file("harness-log.jsonl"))
			? readFileSync(file("harness-log.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
			: [];

	const env = ({ mode, providers = [], extra = {} } = {}) => ({
		...AMBIENT_ENV,
		HOME: dir,
		PI_CODING_AGENT_DIR: dir,
		PI_OFFLINE: "1",
		...(mode && { PI_DATASAFE_MODE: mode }),
		DATASAFE_HARNESS_PROVIDERS: providers.join(","),
		...FAKE_KEYS,
		...extra,
	});

	const pi = (args, options) => {
		const result = spawnSync(PI, ["--no-extensions", "--extension", HARNESS, ...args], {
			cwd: dir,
			env: env(options),
			encoding: "utf8",
			timeout: 30_000,
		});

		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	};

	return {
		dir,
		write,
		log,
		fetches: () => log().filter((entry) => entry.type === "fetch"),
		pi,
		listModels: (search, options) =>
			pi(search === undefined ? ["--list-models"] : ["--list-models", search], options)
				.output.split("\n")
				.flatMap((line) => {
					const row = line.match(/^(\S+)\s+(\S+)\s+\d[\d.]*[KM]?\s/);

					return row ? [`${row[1]}/${row[2]}`] : [];
				}),
		prompt: (args, options) => pi([...args, "--no-tools", "--no-session", "-p", "hello"], options),
	};
}
