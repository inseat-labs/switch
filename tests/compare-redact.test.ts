import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli/main.js";
import { emailsIn, REDACTED_EMAIL, redactEmails } from "../src/report/redact.js";
import { call, out, ScriptedProvider } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const CONFIG = `baseline: fake:big
candidate: fake:small
repeat: 3
tools:
  - name: send_email
    parameters: { type: object, properties: { to: { type: string } }, required: [to] }
cases:
  - name: notify ops
    prompt: tell the team the deploy finished
system: Send status updates to ops@example.com.
`;

const LEAKED = "Jane.Doe@corp-internal.io";
const RECIPIENT = "ops@example.com";

async function runCompare() {
  const cwd = await mkdtemp(join(tmpdir(), "switch-redact-test-"));
  dirs.push(cwd);
  await writeFile(join(cwd, "switch.yaml"), CONFIG);
  const prompt = "tell the team the deploy finished";
  const scripts: Record<string, Record<string, ReturnType<typeof out>[]>> = {
    "fake:big": { [prompt]: [out([call("send_email", { to: RECIPIENT })])] },
    "fake:small": { [prompt]: [out([call("send_email", { to: LEAKED })], `Sent as ${LEAKED}`)] },
  };
  const stdout: string[] = [];
  const cli: CliIo = {
    cwd,
    stdout: (t) => stdout.push(t),
    stderr: () => {},
    providerFactory: (id) => new ScriptedProvider(id, scripts[id] ?? {}),
    now: () => "2026-01-01T00:00:00.000Z",
  };
  const code = await main(["compare", "--json", "report.json", "--no-cache"], cli);
  return {
    code,
    text: stdout.join(""),
    json: await readFile(join(cwd, "report.json"), "utf8"),
    html: await readFile(join(cwd, "switch-report.html"), "utf8"),
  };
}

describe("compare report email redaction", () => {
  it("redacts a leaked account email in the text, JSON, and HTML reports", async () => {
    const { code, text, json, html } = await runCompare();
    expect(code).toBe(0);
    for (const report of [text, json, html]) {
      expect(report.toLowerCase()).not.toContain(LEAKED.toLowerCase());
      expect(report).toContain(REDACTED_EMAIL);
    }
    expect(text).toContain(`send_email.to: "${RECIPIENT}" -> "${REDACTED_EMAIL}"`);
    const parsed = JSON.parse(json);
    expect(parsed.cases[0].samples.candidate[0].toolCalls[0].arguments.to).toBe(REDACTED_EMAIL);
    expect(parsed.cases[0].samples.candidate[0].text).toBe(`Sent as ${REDACTED_EMAIL}`);
  });

  it("keeps an email that appears in the config so the diff stays meaningful", async () => {
    const { text, json, html } = await runCompare();
    for (const report of [text, json, html]) expect(report).toContain(RECIPIENT);
    const parsed = JSON.parse(json);
    expect(parsed.cases[0].samples.baseline[0].toolCalls[0].arguments.to).toBe(RECIPIENT);
  });

  it("redacts truncated emails unless they abbreviate a config email", () => {
    const allowed = emailsIn("notify OPS@Example.com");
    expect(allowed).toEqual(new Set([RECIPIENT]));
    expect(redactEmails('"ops@exam…" and "jane@corp…"', allowed)).toBe(`"ops@exam…" and "${REDACTED_EMAIL}"`);
    expect(redactEmails("Ops@Example.com", allowed)).toBe("Ops@Example.com");
  });

  it.each([
    ["a dotless host", "alice@localhost"],
    ["a quoted local part", '"john doe"@example.com'],
    ["an internationalized address", "用户@例子.广告"],
    ["an accented local part", "josé.pérez@correo.es"],
    ["an RFC 5322 special in the local part", "o'brien+tag@mail.example"],
    ["an address literal", "admin@[192.168.0.1]"],
    ["a numeric first label", "alice@163.com"],
  ])("redacts %s", (_label, email) => {
    expect(redactEmails(`contact ${email}.`, new Set())).toBe(`contact ${REDACTED_EMAIL}.`);
  });

  it("keeps a config email even when punctuation is glued to it", () => {
    const allowed = emailsIn("to: 'ops@example.com'");
    expect(redactEmails("to=ops@example.com", allowed)).toBe("to=ops@example.com");
    expect(redactEmails("ops@example.com", allowed)).toBe("ops@example.com");
  });

  it("leaves version strings that are not email addresses alone", () => {
    expect(redactEmails("install pkg@1.2.3", new Set())).toBe("install pkg@1.2.3");
  });

  it("scans long output in linear time", () => {
    const noAt = "ab-c.".repeat(40_000);
    const manyAt = "1@".repeat(40_000);
    const started = performance.now();
    expect(redactEmails(noAt, new Set())).toBe(noAt);
    expect(redactEmails(manyAt, new Set())).toBe(manyAt);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
