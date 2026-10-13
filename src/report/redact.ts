import type { CompareResult } from "../compare/run.js";

export const REDACTED_EMAIL = "[redacted-email]";

const TRUNCATION_MARK = "…";
const MAX_LOCAL = 128;
const MAX_DOMAIN = 255;
const ATEXT = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]$/u;
const DOMAIN_CHAR = /^[\p{L}\p{M}\p{N}.-]$/u;
const LABEL = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u;
const HAS_LETTER = /\p{L}/u;
const LOCAL_PART_DELIMITER = /[^\p{L}\p{M}\p{N}._%+-]/gu;

/** Code point ending at `index` (exclusive), as [char, its UTF-16 length]. */
function charBefore(text: string, index: number): string {
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) return text.slice(index - 2, index);
  return text.slice(index - 1, index);
}

function charAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index) ?? 0);
}

function localStart(text: string, at: number): number | null {
  if (text[at - 1] === '"') {
    for (let i = at - 2; i >= 0 && at - i <= MAX_LOCAL; i--) {
      const c = text[i];
      if (c === "\n" || c === "\r") return null;
      if (c === '"' && text[i - 1] !== "\\") return at - i > 2 ? i : null;
    }
    return null;
  }
  if (text[at - 1] === ".") return null;
  let i = at;
  while (i > 0 && at - i < MAX_LOCAL) {
    const c = charBefore(text, i);
    if (c !== "." && !ATEXT.test(c)) break;
    i -= c.length;
  }
  while (text[i] === ".") i++;
  return i < at ? i : null;
}

/** Index just after the domain (or `null`), accepting hosts, `[literal]`s and displayValue-truncated domains. */
function domainEnd(text: string, at: number): number | null {
  const first = at + 1;
  if (text[first] === "[") {
    for (let i = first + 1; i < text.length && i - first <= 64; i++) {
      if (/\s/.test(text[i]!)) return null;
      if (text[i] === "]") return i > first + 1 ? i + 1 : null;
    }
    return null;
  }
  let i = first;
  while (i < text.length && i - first < MAX_DOMAIN) {
    const c = charAt(text, i);
    if (!DOMAIN_CHAR.test(c)) break;
    i += c.length;
  }
  if (text.startsWith(TRUNCATION_MARK, i)) return i + TRUNCATION_MARK.length;
  let run = text.slice(first, i);
  const doubleDot = run.indexOf("..");
  if (doubleDot !== -1) run = run.slice(0, doubleDot);
  const labels: string[] = [];
  for (const label of run.split(".")) {
    const trimmed = label.replace(/-+$/u, "");
    if (!LABEL.test(trimmed)) break;
    labels.push(trimmed);
    if (trimmed !== label) break;
  }
  const host = labels.join(".");
  return host !== "" && HAS_LETTER.test(host) ? first + host.length : null;
}

/** Linear-time: only the bounded neighbourhood of each `@` is inspected, so long model output cannot stall it. */
function findEmails(text: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const start = localStart(text, at);
    if (start === null) continue;
    const end = domainEnd(text, at);
    if (end === null) continue;
    found.push({ start, end });
  }
  return found;
}

/**
 * A greedy match can absorb adjacent punctuation that is legal in a local part (`to=ops@x.io`, `'ops@x.io`),
 * so each match is also considered from just after every such character.
 */
function candidates(email: string): string[] {
  const lower = email.toLowerCase();
  const localPart = lower.slice(0, lower.lastIndexOf("@"));
  const found = [lower];
  const delimiter = new RegExp(LOCAL_PART_DELIMITER);
  for (let m = delimiter.exec(localPart); m !== null; m = delimiter.exec(localPart)) {
    const suffix = lower.slice(m.index + m[0].length);
    if (!suffix.startsWith("@")) found.push(suffix);
  }
  return found;
}

export function emailsIn(text: string): Set<string> {
  const found = findEmails(text).flatMap(({ start, end }) => candidates(text.slice(start, end)));
  return new Set(found.filter((email) => !email.endsWith(TRUNCATION_MARK)));
}

function isAllowed(email: string, allowed: ReadonlySet<string>): boolean {
  return candidates(email).some((candidate) => {
    if (!candidate.endsWith(TRUNCATION_MARK)) return allowed.has(candidate);
    const prefix = candidate.slice(0, -TRUNCATION_MARK.length);
    return [...allowed].some((a) => a.startsWith(prefix));
  });
}

/** Emails in `allowed` (lowercased, taken from the config) are kept so expected recipients still diff. */
export function redactEmails(text: string, allowed: ReadonlySet<string>): string {
  let out = "";
  let last = 0;
  for (const { start, end } of findEmails(text)) {
    const email = text.slice(start, end);
    out += text.slice(last, start) + (isAllowed(email, allowed) ? email : REDACTED_EMAIL);
    last = end;
  }
  return out + text.slice(last);
}

function redactValue(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (typeof value === "string") return redactEmails(value, allowed);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, allowed));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactEmails(k, allowed), redactValue(v, allowed)]));
  }
  return value;
}

/** Returns a copy of `result` with leaked email addresses redacted, for rendering reports. */
export function redactCompareResult(result: CompareResult, configText: string): CompareResult {
  return redactValue(result, emailsIn(configText)) as CompareResult;
}
