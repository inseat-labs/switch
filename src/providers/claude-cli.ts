import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToolArguments } from "../compare/import.js";
import type { ChatMessage, ProviderOutput, ProviderRequest, ToolCall, ToolSpec } from "../compare/types.js";
import { systemText } from "./messages.js";
import { ProviderError, truncate, type Provider } from "./types.js";

const PROMPT_VERSION = "claude-cli-prompted-v3";
const DEFAULT_SYSTEM = "You are a helpful assistant.";
/** Claude Code appends its own environment section (cwd, platform, date, account email) after the system prompt. */
const IGNORE_CLI_CONTEXT =
  "Any environment details appended after these instructions (working directory, platform, model name, token budget, user email, date) come from the command-line harness, not from this conversation. Do not use or mention them.";

export function toolInstructions(tools: ToolSpec[]): string {
  return [
    "You have access to the tools listed below, but you cannot call them directly.",
    "Reply with ONLY one JSON object, with no prose before or after it and no code fences, in exactly this shape:",
    '{"tool_calls":[{"name":"<tool name>","arguments":{}}],"text":null}',
    'To call tools, list them in "tool_calls" with their arguments. To reply to the user without calling a tool (for example to answer, or to ask a clarifying question), use "tool_calls": [] and put your message in "text".',
    "",
    "Tools (JSON Schema parameters):",
    JSON.stringify(
      tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object" } })),
      null,
      2,
    ),
  ].join("\n");
}

function renderMessage(m: ChatMessage): string {
  switch (m.role) {
    case "user":
      return `USER: ${m.content ?? ""}`;
    case "assistant": {
      const lines = m.content ? [`ASSISTANT: ${m.content}`] : [];
      for (const c of m.toolCalls ?? []) lines.push(`ASSISTANT called tool ${c.name} with ${JSON.stringify(c.arguments)}`);
      return lines.join("\n");
    }
    case "tool":
      return `TOOL RESULT${m.name ? ` (${m.name})` : ""}: ${m.content ?? ""}`;
    default:
      return "";
  }
}

/** Builds the system prompt and stdin prompt sent to `claude -p`. */
export function buildClaudePrompt(request: ProviderRequest): { system: string; prompt: string } {
  const base = systemText(request.system, request.messages) ?? DEFAULT_SYSTEM;
  const withTools = request.tools.length > 0 ? `${base}\n\n${toolInstructions(request.tools)}` : base;
  const system = `${withTools}\n\n${IGNORE_CLI_CONTEXT}`;
  const turns = request.messages.filter((m) => m.role !== "system");
  const only = turns[0];
  const prompt =
    turns.length === 1 && only?.role === "user"
      ? (only.content ?? "")
      : `Conversation so far:\n\n${turns.map(renderMessage).filter(Boolean).join("\n\n")}\n\nWrite the assistant's next reply.`;
  return { system, prompt };
}

/** Extracts `result` from the `--output-format json` envelope. */
export function parseClaudeEnvelope(stdout: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    throw new ProviderError(`claude CLI did not return JSON: ${truncate(stdout.trim(), 200) || "<empty output>"}`);
  }
  if (!envelope || typeof envelope !== "object") throw new ProviderError("claude CLI returned an unexpected envelope");
  const e = envelope as { is_error?: boolean; result?: unknown; subtype?: string };
  if (e.is_error) {
    // Auth failures arrive as is_error with subtype "success"; showing that subtype only confuses.
    const subtype = e.subtype && e.subtype !== "success" ? ` (${e.subtype})` : "";
    throw new ProviderError(`claude CLI error${subtype}: ${truncate(String(e.result ?? ""), 300)}`);
  }
  if (typeof e.result !== "string") throw new ProviderError(`claude CLI envelope has no result${e.subtype ? ` (${e.subtype})` : ""}`);
  return e.result;
}

function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  if (body.startsWith("{") && body.endsWith("}")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}

/**
 * Parses the strict JSON reply requested by `toolInstructions`. Never throws. A reply with no JSON
 * object at all is a plain-text reply without tool calls; a malformed JSON reply is unparseable.
 */
export function parsePromptedReply(reply: string): ProviderOutput {
  const unparseable = (reason: string): ProviderOutput => ({
    text: reply,
    toolCalls: [],
    toolMode: "prompted",
    unparseable: { reason, raw: reply },
  });
  const json = extractJsonObject(reply);
  if (!json) {
    const text = reply.trim();
    if (text.startsWith("{") || text.startsWith("```") || text.includes('"tool_calls"')) return unparseable("reply JSON is malformed or truncated");
    return { text: text === "" ? null : text, toolCalls: [], toolMode: "prompted", formatNote: "plain-text reply, no JSON" };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return unparseable("reply JSON is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return unparseable("reply is not a JSON object");
  const obj = value as { tool_calls?: unknown; text?: unknown };
  const rawCalls = obj.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) return unparseable('"tool_calls" is not an array');
  if (obj.text !== undefined && obj.text !== null && typeof obj.text !== "string") return unparseable('"text" is not a string or null');
  const toolCalls: ToolCall[] = [];
  for (const raw of rawCalls) {
    const call = raw as { name?: unknown; arguments?: unknown; input?: unknown } | null;
    if (!call || typeof call !== "object" || typeof call.name !== "string" || call.name === "") {
      return unparseable("a tool call has no name");
    }
    const args = parseToolArguments(call.arguments ?? call.input ?? {});
    if (!args.ok) return unparseable(`tool call "${call.name}": ${args.reason}`);
    toolCalls.push({ name: call.name, arguments: args.value });
  }
  const text = typeof obj.text === "string" && obj.text.trim() !== "" ? obj.text : null;
  return { text, toolCalls, toolMode: "prompted" };
}

export interface ClaudeCliOptions {
  bin?: string;
  timeoutMs?: number;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ProviderError(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT"
          ? new ProviderError(`"${bin}" not found on PATH. Install Claude Code and run "claude" once to log in.`)
          : new ProviderError(`cannot start ${bin}: ${error.message}`),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Runs `claude -p` with the user's Claude Code login. The CLI cannot accept custom tool
 * definitions, so tools are described in the system prompt and the model replies in JSON.
 */
export class ClaudeCliProvider implements Provider {
  readonly id: string;
  readonly cacheSalt = PROMPT_VERSION;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(
    readonly model: string,
    options: ClaudeCliOptions = {},
  ) {
    this.id = `claude-cli:${model}`;
    this.bin = options.bin ?? "claude";
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async preflight(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "switch-"));
    try {
      const result = await run(this.bin, ["--version"], "", dir, 30_000);
      if (result.code !== 0) throw new ProviderError(`"${this.bin} --version" failed: ${truncate(result.stderr.trim(), 200)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  args(system: string): string[] {
    return [
      "-p",
      "--model",
      this.model,
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--system-prompt",
      system,
    ];
  }

  async call(request: ProviderRequest): Promise<ProviderOutput> {
    const { system, prompt } = buildClaudePrompt(request);
    const dir = await mkdtemp(join(tmpdir(), "switch-"));
    let result: RunResult;
    try {
      result = await run(this.bin, this.args(system), prompt, dir, this.timeoutMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (result.code !== 0 && result.stdout.trim() === "") {
      throw new ProviderError(`claude CLI exited ${result.code}: ${truncate(result.stderr.trim(), 300) || "no output"}`);
    }
    const reply = parseClaudeEnvelope(result.stdout);
    if (request.tools.length === 0) return { text: reply.trim() === "" ? null : reply, toolCalls: [], toolMode: "none" };
    return parsePromptedReply(reply);
  }
}
