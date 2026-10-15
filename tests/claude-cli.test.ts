import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClaudePrompt, ClaudeCliProvider, parseClaudeEnvelope, parsePromptedReply } from "../src/providers/claude-cli.js";
import { ProviderError } from "../src/providers/types.js";

const tools = [{ name: "send_email", parameters: { type: "object", properties: { to: { type: "string" } } } }];

describe("parseClaudeEnvelope", () => {
  it("returns the result field", () => {
    expect(parseClaudeEnvelope(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hi!" }))).toBe("Hi!");
  });

  it("throws a provider error for CLI errors and non-JSON output", () => {
    expect(() => parseClaudeEnvelope(JSON.stringify({ is_error: true, subtype: "error", result: "Not logged in" }))).toThrow(/Not logged in/);
    expect(() => parseClaudeEnvelope("Error: something")).toThrow(ProviderError);
    expect(() => parseClaudeEnvelope(JSON.stringify({ subtype: "error_max_turns" }))).toThrow(/no result/);
  });

  it("leaves out a misleading success subtype on errors", () => {
    const envelope = JSON.stringify({ is_error: true, subtype: "success", result: "Failed to authenticate" });
    expect(() => parseClaudeEnvelope(envelope)).toThrow("claude CLI error: Failed to authenticate");
  });
});

describe("parsePromptedReply", () => {
  it("parses a strict JSON reply", () => {
    expect(parsePromptedReply('{"tool_calls":[{"name":"send_email","arguments":{"to":"a@b.c"}}],"text":null}')).toEqual({
      text: null,
      toolCalls: [{ name: "send_email", arguments: { to: "a@b.c" } }],
      toolMode: "prompted",
    });
  });

  it("strips code fences and surrounding prose", () => {
    expect(parsePromptedReply('```json\n{"tool_calls":[],"text":"Which date?"}\n```').text).toBe("Which date?");
    expect(parsePromptedReply('Sure:\n{"tool_calls":[{"name":"x","arguments":"{\\"a\\":1}"}]}\nDone').toolCalls).toEqual([{ name: "x", arguments: { a: 1 } }]);
  });

  it("treats a reply with no JSON at all as a plain-text reply without tool calls", () => {
    expect(parsePromptedReply("Who should I send it to?\n")).toEqual({
      text: "Who should I send it to?",
      toolCalls: [],
      toolMode: "prompted",
      formatNote: "plain-text reply, no JSON",
    });
  });

  it.each([
    ['{"tool_calls": [ {"name": "x", }', "malformed"],
    ['{"tool_calls":"send_email"}', "not an array"],
    ['{"tool_calls":[{"arguments":{}}]}', "no name"],
    ['{"tool_calls":[],"text":5}', "text"],
  ])("reports %s as unparseable instead of throwing", (reply, reason) => {
    const result = parsePromptedReply(reply);
    expect(result.unparseable?.reason).toContain(reason);
    expect(result.unparseable?.raw).toBe(reply);
    expect(result.toolCalls).toEqual([]);
  });
});

describe("buildClaudePrompt", () => {
  it("describes tools in the system prompt and passes a single user prompt verbatim", () => {
    const { system, prompt } = buildClaudePrompt({ model: "haiku", system: "Be kind.", messages: [{ role: "user", content: "Email Ann" }], tools });
    expect(system.startsWith("Be kind.")).toBe(true);
    expect(system).toContain('"send_email"');
    expect(system).toContain('"tool_calls"');
    expect(prompt).toBe("Email Ann");
  });

  it("renders multi-turn conversations as a transcript", () => {
    const { prompt, system } = buildClaudePrompt({
      model: "haiku",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, toolCalls: [{ name: "send_email", arguments: { to: "a" } }] },
        { role: "tool", content: "sent", name: "send_email" },
      ],
      tools: [],
    });
    expect(system.startsWith("You are a helpful assistant.")).toBe(true);
    expect(system).toContain("Do not use or mention them.");
    expect(prompt).toContain("USER: hi");
    expect(prompt).toContain('ASSISTANT called tool send_email with {"to":"a"}');
    expect(prompt).toContain("TOOL RESULT (send_email): sent");
  });
});

describe("ClaudeCliProvider with a fake CLI", () => {
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "switch-fake-claude-"));
    bin = join(dir, "fake-claude");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (fake)"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const model = args[args.indexOf("--model") + 1];
  if (model === "broken") { console.log(JSON.stringify({ type: "result", is_error: false, result: '{"tool_calls": [' })); return; }
  const reply = { tool_calls: [{ name: "echo", arguments: { input, cwd: process.cwd(), tools: args[args.indexOf("--tools") + 1], model } }], text: null };
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "\`\`\`json\\n" + JSON.stringify(reply) + "\\n\`\`\`" }));
});
`,
    );
    await chmod(bin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes the prompt on stdin without a shell and runs in a temp directory", async () => {
    const provider = new ClaudeCliProvider("sonnet", { bin });
    await provider.preflight();
    const hostile = "Email $(rm -rf ~) `id` 'quote' \"dq\"";
    const result = await provider.call({ model: "sonnet", messages: [{ role: "user", content: hostile }], tools });
    const args = result.toolCalls[0]!.arguments;
    expect(result.toolMode).toBe("prompted");
    expect(args.input).toBe(hostile);
    expect(args.tools).toBe("");
    expect(args.model).toBe("sonnet");
    expect(String(args.cwd)).toContain("switch-");
    expect(String(args.cwd)).not.toBe(process.cwd());
  });

  it("returns an unparseable sample when the model sends malformed JSON", async () => {
    const result = await new ClaudeCliProvider("broken", { bin }).call({ model: "broken", messages: [{ role: "user", content: "x" }], tools });
    expect(result.unparseable?.reason).toBe("reply JSON is malformed or truncated");
  });

  it("gives a clear error when the CLI is missing", async () => {
    const provider = new ClaudeCliProvider("sonnet", { bin: join(dir, "does-not-exist") });
    await expect(provider.preflight()).rejects.toThrow(/not found on PATH/);
  });
});
