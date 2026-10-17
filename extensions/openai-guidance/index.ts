import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { baseWithoutPrevious, guidanceBlock, loadTexts, modelFamily, readConfig, selectRules } from "./guidance.ts";

export default function openaiGuidance(pi: ExtensionAPI) {
  const texts = loadTexts();
  const configPath = join(homedir(), ".pi", "agent", "openai-guidance.json");
  let previous = "";
  pi.on("before_agent_start", (event, ctx) => {
    const base = baseWithoutPrevious(event.systemPrompt, previous);
    previous = "";
    if (!modelFamily(ctx.model)) {
      return base === event.systemPrompt ? undefined : { systemPrompt: base };
    }
    // Read at each user turn: opt-outs take effect without restarting Pi.
    const config = readConfig(configPath);
    previous = guidanceBlock(selectRules(ctx.model, pi.getActiveTools(), config), texts);
    return { systemPrompt: base + previous };
  });
}
