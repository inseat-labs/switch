# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/); while the version is `0.x`, any
release may contain breaking changes.

## Unreleased

### Fixed

- `claude-cli` errors no longer show a misleading `(success)` label, for example
  when the Claude Code login has expired.
- The `agent-upgrade` example uses fixed dates (one future, one past) so its
  results no longer drift as the calendar moves. New `schedule past date` case;
  the example now uses `repeat: 3`. README and reports updated from a 2026-10-15 run.

## 0.2.1 - 2026-10-13

### Changed

- Published to npm as [`switch-llm`](https://www.npmjs.com/package/switch-llm).
  Install or run it with `npx switch-llm`; the command is still `switch`. The
  README, help text and website now use the npm command instead of
  `npx github:inseat-labs/switch`, which still works.

## 0.2.0 - 2026-10-13

### Added

- `switch compare [switch.yaml]`: snapshot tests for model upgrades. Runs
  every case on a baseline and a candidate model `repeat` times. It reports
  consistent tool-behavior changes (`tool-dropped`, `tool-added`,
  `tool-switched`, `arg-added`, `arg-removed`, `arg-value-changed`,
  `args-invalid`, `acted-instead-of-asking`, `asked-instead-of-acting`,
  `refused`, `output-unparseable`, `text-only-change`). Differences that are not
  consistent are reported as `flaky` and do not fail the run.
  Exit codes: `0` no regression, `1` regression or unsampled case, `2` invalid
  config, credentials, or flags.
- `switch init`: writes a commented starter `switch.yaml` and refuses
  to overwrite an existing one.
- YAML/JSON config with `provider:model` ids, `system`, OpenAI function-style
  `tools`, and cases given as `prompt`, `messages`, or `import`.
- Providers: `claude-cli` (Claude Code login, prompted JSON tool mode),
  `anthropic` (Messages API, native tools), `openai` (Chat Completions, native
  tools, `OPENAI_BASE_URL` for compatible servers).
- Import of recorded OpenAI chat-completions JSONL. Recorded responses become
  extra baseline samples.
- On-disk response cache in `.switch-cache/` and a `--no-cache` flag.
- Terminal summary, `--json <file>` report (`reportVersion: 1`, `kind:
  "compare"`), and a self-contained escaped HTML report with side-by-side
  samples.
- Real example in `examples/compare/` (Sonnet vs Haiku via `claude-cli`).
- `prepare` script so `npx github:inseat-labs/switch` builds on install.
- Dependency: `yaml`.

- Reports redact leaked email addresses. Any address in the text, JSON, or HTML
  report that does not appear in the compare config becomes `[redacted-email]`;
  config addresses are kept so recipient changes still diff. The scanner is
  linear-time, so long model output cannot stall a run. Written by
  `fusion run` (Claude), reviewed by Codex, finished by a maintainer.
- README demo GIF of a real `compare` run.

### Changed

- Renamed to switch: package `@inseat-labs/switch`, bin `switch`, repository
  `inseat-labs/switch` (previously `inseat-switch`).
- `main()` in `src/cli/main.ts` accepts an optional I/O and provider-factory
  argument (used by tests). The behavior of `check` is unchanged.

## 0.1.0 - 2026-09-26

First tagged release of the Milestone 0 offline starter. Early-stage: fixture
and report formats may still change, and the package is not published to npm.

### Added

- `inseat-switch check <fixture.json>...` CLI with a text report, `--json`
  machine-readable report (`reportVersion: 1`), and `--allow-fail`. Exit codes:
  `0` no failing checks, `1` at least one check failed, `2` usage error or a
  fixture could not be loaded.
- Fixture format v1 with Zod validation and readable load errors.
- Saved-response adapter for `generic-v1`, `openai-chat-v1`, and `unavailable`
  formats.
- Deterministic checks, each returning `pass`, `fail`, or `not-tested` with a
  stable reason code:
  - `tool-name`
  - `tool-arguments` (JSON Schema 2020-12 via Ajv)
  - `structured-output`
  - `outcome-assertion` (exact match, JSON Schema, property paths, and saved
    allowlisted verifier results)
- Ten synthetic example fixtures, one invalid fixture, and 40 tests.
- GitHub Actions CI on Node.js 22 and 24.

### Limits

- Offline only: no network requests, provider calls, live model adapters, or
  command execution. Verifier results must already be saved in the fixture.
- Workflow-precondition checks, project config files, and redaction are not
  implemented yet. See `ROADMAP.md` and `docs/HANDOFF.md`.
