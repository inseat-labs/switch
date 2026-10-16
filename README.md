# Switch

**Snapshot tests for AI model upgrades.** Switch runs your real prompts on your
current model and on the model you want to switch to, several times each, and
reports only the tool-calling behaviors that change consistently.

Your current model's behavior is the baseline. You do not write expected answers
or assertions.

![switch compare: Sonnet vs Haiku on seven agent tasks: five unchanged, one change, one flaky](https://raw.githubusercontent.com/inseat-labs/switch/main/docs/demo.gif)

<sub>A real run (Claude Sonnet → Haiku on the example config, 2026-10-15); the 84-second wait is sped up.</sub>

> Status: early (0.x). Published to npm as [`switch-llm`](https://www.npmjs.com/package/switch-llm); the command is `switch`.
> Formats and categories may still change.

## 30-second quickstart

Requires Node.js 22+. The default config uses the `claude` CLI (Claude Code) with
your existing login, so no API key is needed to try it.

```bash
npx switch-llm init      # writes a commented switch.yaml
npx switch-llm compare   # baseline vs candidate, writes switch-report.html
```

When installed, the same commands are `switch init` and `switch compare`.

Real output from [examples/compare/agent-upgrade.yaml](examples/compare/agent-upgrade.yaml)
(7 everyday agent cases, 3 tools, `claude-cli:sonnet` vs `claude-cli:haiku`,
`repeat: 3`, 84 seconds, run on 2026-10-15). Full reports:
[report.html](examples/compare/report.html), [report.json](examples/compare/report.json).

```text
Switch  claude-cli:sonnet -> claude-cli:haiku   7 cases x 3 samples
(claude-cli: tools are described in the prompt and returned as JSON, not native tool calls)
? FLAKY       search docs              arg search_docs.limit (3/3 -> 2/3)
✓ SAME        search with limit
✓ SAME        schedule with details
~ CHANGE      schedule past date       asked-instead-of-acting: asked a clarifying question instead of calling create_calendar_event (acted 3/3 -> 1/3, asked 0/3 -> 2/3)
✓ SAME        schedule missing date
✓ SAME        email with recipient
✓ SAME        email missing recipient
calls: 42 live, 0 cached, 0 failed
Result: 0 regression, 1 change, 5 same, 1 flaky   report: examples/compare/report.html
```

Haiku used the same tools and identifier-like arguments as Sonnet, and asked for
the missing date and recipient too. Two differences:

- **schedule past date** (a meeting on 2025-01-07): Sonnet created the event in
  all 3 samples. Haiku pointed out the date had passed and asked which date was
  meant in 2 of 3. That is a consistent change, so Switch reports it. Here the
  candidate's behavior is arguably better; Switch tells you what changed, and you
  decide whether it matters.
- **search docs**: Haiku left out the optional `limit` argument once in 3
  samples. It did not repeat, so it is flaky and does not fail the run.

Why the example uses fixed dates: an earlier version asked for a meeting on
2026-10-06. Once that date passed, the same "fully specified" case started
changing between runs, because the models began reacting to a past date. Pin
dates in your own cases, or add a case for the date behavior you care about.

## What it reports

For each case, each sample is normalized to tool calls (name and arguments),
text, whether it asked a clarifying question, whether it refused, and whether
its arguments validate against the tool's JSON Schema (Ajv). A difference is a
finding only when it appears in **more than half** of one model's samples and
**fewer than half** of the other's. Any other difference is **flaky**. Flaky
differences are listed but never fail the run.

| Category | Severity | Meaning |
| --- | --- | --- |
| `tool-dropped` | regression | baseline calls the tool, candidate does not |
| `tool-switched` | regression | candidate calls a different tool instead |
| `args-invalid` | regression | candidate arguments break the tool schema |
| `acted-instead-of-asking` | regression | baseline asked for missing details, candidate called a tool |
| `refused` | regression | candidate refuses where the baseline did not |
| `output-unparseable` | regression | candidate replies could not be parsed (prompted mode) |
| `tool-added` | change | candidate calls an extra tool |
| `arg-added` / `arg-removed` | change | e.g. an invented optional argument |
| `arg-value-changed` | change | a stable identifier-like value (id, email, date, number, enum) changed |
| `asked-instead-of-acting` | change | candidate asks where the baseline acted |
| `text-only-change` | info | reply text appears, disappears, or changes length a lot |

Exit codes: `0` no regression, `1` at least one regression or a case with no
usable samples, `2` invalid config, missing credentials or CLI, or bad flags.

## Config

```yaml
baseline: claude-cli:sonnet        # provider:model
candidate: claude-cli:haiku
repeat: 3                          # samples per model per case
system: "You are a support agent..."   # optional
tools:                             # optional, OpenAI function style
  - name: lookup_order
    description: Look up an order by id.
    parameters: { type: object, properties: { orderId: { type: string } }, required: [orderId] }
cases:
  - name: lookup order
    prompt: "Where is order ORD-123456?"     # or messages: [...] (OpenAI chat format)
  - import: logs/openai-chat.jsonl           # optional: recorded traffic
```

JSON configs work too (`compare switch.json`). Options: `--repeat <n>`,
`--json <file>` (`-` for stdout), `--html <file>` (default `switch-report.html`),
`--no-html`, `--no-cache`, `--concurrency <n>`.

### Email redaction

The text, JSON, and HTML reports replace any email address that does not appear
in your config file with `[redacted-email]`, so an account address a model leaks
into a reply or tool call is not written to a report you might share. Addresses
that do appear in the config (for example an expected `send_email` recipient) are
kept, so a changed recipient still shows up in the diff. Redaction happens only
when reports are rendered: comparison and the response cache use the raw output.
Addresses that appear only in an `import:`ed file are redacted. Dotless hosts
(`alice@localhost`), quoted local parts, address literals, and internationalized
addresses are all treated as email addresses.

### Providers

| Id | Needs | Tool calling |
| --- | --- | --- |
| `claude-cli:<model>` | `claude` on PATH, logged in | **prompted**: tools are described in the system prompt and the model must reply with `{"tool_calls": [...], "text": ...}` |
| `anthropic:<model>` | `ANTHROPIC_API_KEY` (optional `ANTHROPIC_BASE_URL`) | native (Messages API) |
| `openai:<model>` | `OPENAI_API_KEY`, and/or `OPENAI_BASE_URL` for OpenRouter, Ollama, vLLM, or any compatible server | native (Chat Completions) |

`claude-cli` runs `claude -p --output-format json` without a shell, with built-in
tools disabled (`--tools ""`), no MCP servers or settings files, no session
persistence, and a fresh temporary working directory. Keys are read from the
environment and never logged.

### Cache

Responses are cached in `.switch-cache/`, keyed by provider, model, system
prompt, messages, tools, and sample index, so reruns cost nothing. Delete the
directory or pass `--no-cache` to resample.

### Importing recorded traffic

An `import:` case reads OpenAI chat-completions JSONL. Each line is
`{"request": {"model", "messages", "tools"}, "response": {"choices": [{"message"}]}}`
or the bare `{"messages", "tools", "response"}` form. Each line becomes a case,
and its recorded response is added as one extra **baseline** sample.

## How it compares

These tools are mature and broader than Switch. Switch does one narrow thing.

| | Strength | How you define "correct" | Separates noise from change | Tool-call behavior diff |
| --- | --- | --- | --- | --- |
| [promptfoo](https://github.com/promptfoo/promptfoo) | YAML evals across many providers, assertions, LLM-graded rubrics, red teaming, caching, web viewer | assertions you write per test | `--repeat` runs tests again; pass or fail is still per assertion | through assertions you write |
| [DeepEval](https://github.com/confident-ai/deepeval) | pytest-style LLM tests, many LLM-as-judge metrics, tool-correctness metric | expected outputs/tools and metric thresholds you provide | not its focus | compares against expected tools you list |
| [OpenAI Evals](https://github.com/openai/evals) | eval framework and registry, model-graded evals | datasets with ideal answers or graders | not its focus | not its focus |
| **Switch** | model-upgrade diff of tool behavior | none: the current model's behavior is the snapshot | repeat sampling, majority rule, explicit `flaky` | categories such as `tool-dropped`, `arg-added`, `acted-instead-of-asking` |

What Switch adds: baseline snapshots with no assertions, repeated sampling that
keeps model nondeterminism out of the failure list, tool-behavior diff
categories, and a keyless trial through your Claude Code login. What it does not
do: judge answer quality or correctness, red-team, score text semantically, or
run multi-step agent loops. If you already have assertions, use them with a
general eval tool as well.

## Limitations

- **Prompted tool mode.** `claude-cli` cannot take custom tool definitions. Its
  JSON protocol approximates native tool calling but is not identical to it. A reply
  with no JSON is treated as a plain-text reply with no tool call and tagged in
  the report. Malformed JSON is kept as an `unparseable` sample. Use
  `anthropic:` or `openai:` for native tool calling.
- **Claude Code adds its own context.** `claude -p` appends an environment
  section after the system prompt (working directory, platform, model name, date, and
  the logged-in account email). Switch tells the model to ignore it, and
  reports redact any email address that is not in your config (see
  [Email redaction](#email-redaction)). The local `.switch-cache/` keeps raw
  responses; do not share or commit it.
- **Heuristics.** "Asked a clarifying question" and "refused" are English
  regex heuristics on replies without tool calls.
- **Free text is not diffed.** Argument values containing spaces (queries,
  email bodies, titles) are not compared, because rewording is expected. Only
  identifier-like values are compared.
- **Small samples.** With `repeat: 2`, only a 2/2 vs 0/2 split counts as
  consistent. Use 3 or more for decisions.
- **Imported samples.** Recorded responses may come from a different model,
  temperature, or system prompt than the configured baseline. They are added as
  baseline samples as-is.
- **One turn.** Switch compares the model's next reply to a fixed conversation.
  It does not execute tools or follow multi-step agent loops.

## Intended audience

Application and platform developers who own an LLM-backed workflow and want
evidence about whether a model upgrade changes that workflow's tool behavior.

Switch is not a general model benchmark, model router, scorer, prompt
optimizer, dataset manager, or agent orchestrator. It has no LLM judge. It is
also distinct from Fusion.

## Advanced: offline `check` of saved responses

`switch check` is the original Milestone 0 checker. It compares saved
baseline and candidate responses in JSON fixtures against explicit
expectations. It returns `pass`, `fail`, or `not-tested` for tool name, tool
arguments, structured output, and deterministic outcome assertions. It makes no
network calls.

### Quick start (offline)

Requires Node.js 22 or newer.

```bash
git clone https://github.com/inseat-labs/switch.git
cd switch
npm ci
npm test
npm run check:examples
```

`check:examples` runs the CLI against the synthetic fixtures in
`examples/fixtures/` and prints `PASS`, `FAIL`, or `SKIP` (not-tested) per check.

> **Expected result:** the example fixtures deliberately include regressions and
> missing evidence, so you will see `FAIL` and `SKIP` lines and the summary
> `11 case(s): 9 pass, 4 fail, 5 not-tested` (totals count checks, not cases).
> `npm` reports a non-zero exit because some fixtures intentionally fail. That
> means the checker is working, not that your install is broken.

The process exits `1` when any check fails, which makes it usable as a CI gate.

To explore the examples without a failing exit code (as CI does), pass
`--allow-fail`; fixture load errors still exit `2`:

```bash
npm run check:examples -- --allow-fail
npm run check:examples -- --json --allow-fail  # machine-readable report
```

Everything runs offline. No provider credentials, network calls, or paid API usage
are involved. See [ROADMAP.md](ROADMAP.md) for acceptance criteria and
[docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md) for the product boundary.

## Fixture format for `check` (v1)

A fixture is one JSON file describing one workflow case:

| Field                                       | Purpose                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `baseline`, `candidate`                     | Provider and model identifiers for labeling.                                    |
| `messages`                                  | The conversation the models were given.                                         |
| `tools`                                     | Tool definitions with JSON Schema `parameters`.                                 |
| `expectations.requiredTool`                 | The tool the workflow requires. Falls back to the baseline's first tool call.   |
| `expectations.outputSchema`                 | JSON Schema the candidate's text output must satisfy.                           |
| `expectations.outcome`                      | Deterministic business-outcome assertion over saved evidence. See below.        |
| `checks`                                    | Any of `tool-name`, `tool-arguments`, `structured-output`, `outcome-assertion`. |
| `responses.baseline`, `responses.candidate` | Saved responses in `generic-v1`, `openai-chat-v1`, or `unavailable` format.     |
| `outcomeEvidence.candidate`                 | Saved outcome `record` (any JSON) and saved `verifiers` results. Optional.      |

### Minimal fixture

The smallest valid fixture includes the required fields `version`, `name`,
`baseline`, `candidate`, `messages`, `checks`, and `responses`. The `description`
and `outcomeEvidence` fields are optional. The `tools` and `expectations` fields
are also omitted below because they have defaults (`[]` and `{}` respectively).

```json
{
  "version": 1,
  "name": "minimal-tool-name",
  "baseline": {
    "provider": "example",
    "model": "baseline-model"
  },
  "candidate": {
    "provider": "example",
    "model": "candidate-model"
  },
  "messages": [
    {
      "role": "user",
      "content": "Find the weather."
    }
  ],
  "checks": ["tool-name"],
  "responses": {
    "baseline": {
      "format": "generic-v1",
      "toolCalls": [
        {
          "name": "get_weather",
          "arguments": {}
        }
      ]
    },
    "candidate": {
      "format": "generic-v1",
      "toolCalls": [
        {
          "name": "get_weather",
          "arguments": {}
        }
      ]
    }
  }
}
```

This example is synthetic and contains no credentials, customer data, or provider
output. With no `expectations.requiredTool` configured, the `tool-name` check uses
the baseline's first tool call (`get_weather`) as the expected tool name.

### Outcome assertions

The `outcome-assertion` check answers "did the workflow achieve its business
outcome?" using only evidence saved in the fixture. It never runs anything and
never consults a model.

```json
"expectations": {
  "outcome": {
    "source": "outcome-record",
    "exact": { "order": { "status": "refunded" } },
    "schema": { "type": "object", "required": ["order"] },
    "paths": [{ "path": "order.status", "equals": "refunded" }],
    "verifiers": [{ "kind": "test-suite", "name": "refund-e2e", "expect": "pass" }]
  }
}
```

* `source` is `outcome-record` (default, reads `outcomeEvidence.candidate.record`)
  or `candidate-text` (parses the candidate's text as JSON).
* `exact`, `schema`, and `paths` compare the record. Paths look like `a.b[0].c`.
* `verifiers` name allowlisted verifier kinds (`command-exit-code`,
  `test-suite`, `http-status`, `boolean-predicate`) whose results must already
  be saved under `outcomeEvidence.candidate.verifiers`. Nothing is executed.
* Any predicate that fails makes the check `fail`. Otherwise any predicate whose
  evidence is missing makes it `not-tested`. Only when every predicate is
  satisfied does it `pass`.

Reason codes: `outcome-satisfied`, `exact-mismatch`, `schema-violation`,
`path-mismatch`, `not-json`, `verifier-failed` (fail);
`no-outcome-assertion`, `no-outcome-evidence`, `candidate-unavailable`,
`path-not-found`, `verifier-missing`, `verifier-unavailable`,
`verifier-not-allowlisted` (not-tested).

Missing evidence produces `not-tested`, never an implicit `pass`. See
[examples/README.md](examples/README.md) for the scenario table.

## Architecture

The implementation is one TypeScript package. `compare` lives in `src/compare`
(config, import, behavior normalization, diff engine, cache, runner),
`src/providers`, and `src/report/compare-*`. `check` uses the fixture, adapter,
check, and runner modules. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Project documents

* [ARCHITECTURE.md](ARCHITECTURE.md): components, implementation status, and data flow
* [ROADMAP.md](ROADMAP.md): milestones and acceptance criteria
* [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md): users, jobs, risks, and boundaries
* [docs/RESEARCH.md](docs/RESEARCH.md): source-backed context and hypotheses
* [examples/README.md](examples/README.md): synthetic fixture examples
* [docs/HANDOFF.md](docs/HANDOFF.md): implementation state and next steps
* [docs/ADR-001-JEV-ADVISORY-ONLY.md](docs/ADR-001-JEV-ADVISORY-ONLY.md): why no probabilistic decision provider is integrated and the conditions for an optional advisory one
* [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute
* [SECURITY.md](SECURITY.md): private vulnerability reporting
* [CHANGELOG.md](CHANGELOG.md): release notes

## License and independence

Switch is open source under the Apache License 2.0; see
[LICENSE](LICENSE). Switch is not affiliated with or endorsed by any model
provider or other vendor referenced in this repository.
