import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalGate, canonicalJson, hashArguments } from "../src/main/security/approval";
import { AuditLog } from "../src/main/security/audit";
import { checkEgress } from "../src/main/security/egress";
import { containsSecret, redact, redactValue } from "../src/main/security/redact";
import { webFetch } from "../src/main/web/fetch";

const base = {
  runId: "run-1",
  callId: "call-1",
  tool: "workspace.write",
  risk: "write",
  workspace: "C:\\work",
};

describe("approval gate", () => {
  it("binds the digest to normalized arguments and the request identity", () => {
    const gate = new ApprovalGate("policy-7");
    const first = gate.open({ ...base, argumentsJson: '{"path":"a.txt","content":"x"}' });
    const reordered = gate.open({ ...base, callId: "call-1", argumentsJson: '{ "content":"x", "path":"a.txt" }' });
    expect(first.digest).toBe(reordered.digest);

    const tampered = gate.open({ ...base, argumentsJson: '{"path":"a.txt","content":"y"}' });
    expect(tampered.digest).not.toBe(first.digest);

    const otherWorker = gate.open({ ...base, agentName: "ALPHA", argumentsJson: '{"path":"a.txt","content":"x"}' });
    expect(otherWorker.digest).not.toBe(first.digest);

    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(hashArguments('{"a":1}')).toBe(hashArguments('{ "a" : 1 }'));
  });

  it("consumes exactly once, refuses replays, and expires on its own clock", () => {
    let now = 1_000_000;
    const gate = new ApprovalGate("policy-7", 5_000, () => now);
    const record = gate.open({ ...base, argumentsJson: "{}" });

    expect(gate.consume(record.id)).toMatchObject({ ok: true });
    expect(gate.consume(record.id)).toEqual({ ok: false, reason: "unknown" });

    const expiring = gate.open({ ...base, callId: "call-2", argumentsJson: "{}" });
    now += 6_000;
    expect(gate.consume(expiring.id)).toEqual({ ok: false, reason: "expired" });

    const cancelled = gate.open({ ...base, callId: "call-3", argumentsJson: "{}" });
    expect(gate.cancelRun(base.runId)).toContain(cancelled.id);
    expect(gate.consume(cancelled.id)).toMatchObject({ ok: false });
    expect(gate.pending()).toBe(0);
    expect(gate.pending("other-run")).toBe(0);
  });
});

describe("redaction", () => {
  it("masks known secrets and common credential shapes without destroying text", () => {
    const secret = "super-secret-value-123";
    const text = `key=${secret} Authorization: Bearer abcdefghijklmnop sk-abcdefgh12345678 and a normal sentence`;
    const out = redact(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("sk-abcdefgh12345678");
    expect(out).toContain("normal sentence");
    expect(containsSecret(`prefix ${secret} suffix`, [secret])).toBe(true);
    expect(containsSecret("nothing to see", [secret])).toBe(false);
    expect(containsSecret("-----BEGIN RSA PRIVATE KEY-----\nabc", [])).toBe(true);

    const value = redactValue({ apiKey: "abc", nested: { token: "t", note: "ok" } }, []);
    expect(value).toEqual({ apiKey: "[redacted]", nested: { token: "[redacted]", note: "ok" } });
  });

  it("caps oversized payloads and deep structures instead of looping", () => {
    const huge = redact("x".repeat(250_000));
    expect(huge.length).toBeLessThan(201_000);
    expect(huge).toContain("[truncated]");
    expect(redactValue(Array.from({ length: 600 }, () => "value"))).toHaveLength(500);
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let index = 0; index < 12; index += 1) deep = { child: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[truncated]");
  });
});

describe("egress policy", () => {
  it("blocks cloud metadata by default, allows loopback, and can go strict", () => {
    expect(checkEgress("http://169.254.169.254/latest/meta-data", "block-metadata")).toMatchObject({ allowed: false });
    expect(checkEgress("http://127.0.0.1:8080/", "block-metadata")).toMatchObject({ allowed: true });
    expect(checkEgress("http://127.0.0.1:8080/", "block-private")).toMatchObject({ allowed: false });
    expect(checkEgress("http://10.0.0.5/", "block-private")).toMatchObject({ allowed: false });
    expect(checkEgress("http://192.168.1.20/", "block-private")).toMatchObject({ allowed: false });
    expect(checkEgress("http://10.0.0.5/", "open")).toMatchObject({ allowed: true });
    expect(checkEgress("file:///etc/passwd", "open")).toMatchObject({ allowed: false });
    expect(checkEgress("https://example.com/", "block-private")).toMatchObject({ allowed: true });
  });

  it("refuses a metadata fetch before any network call", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("should not happen");
    }) as unknown as typeof fetch;
    await expect(webFetch({
      url: "http://169.254.169.254/latest/meta-data",
      signal: new AbortController().signal,
      fetchImpl,
      policy: "block-metadata",
    })).rejects.toThrow(/Egress blocked/u);
    expect(calls).toBe(0);
  });

  it("blocks a redirect into metadata without following it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    }) as unknown as typeof fetch;
    await expect(webFetch({
      url: "https://example.test/redirect",
      signal: new AbortController().signal,
      fetchImpl,
      policy: "block-metadata",
    })).rejects.toThrow(/Egress blocked on redirect/u);
    expect(calls).toBe(1);
  });

  it("handles metadata host names, IPv6 metadata and malformed input", () => {
    expect(checkEgress("https://metadata.google.internal/computeMetadata", "block-metadata")).toMatchObject({ allowed: false });
    expect(checkEgress("http://[fd00:ec2::254]/", "block-metadata")).toMatchObject({ allowed: false });
    expect(checkEgress("http://app.internal/", "block-private")).toMatchObject({ allowed: false });
    expect(checkEgress("not a url", "open")).toMatchObject({ allowed: false });
    expect(checkEgress("http://0.0.0.0/", "block-private")).toMatchObject({ allowed: false });
    expect(checkEgress("http://999.1.1.1/", "block-private")).toMatchObject({ allowed: false });
    expect(checkEgress("http://100.64.0.9/", "block-private")).toMatchObject({ allowed: false });
  });
});

describe("audit log", () => {
  it("appends redacted JSON lines and tails the latest entries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-audit-"));
    const file = path.join(directory, "audit.log");
    const secret = "sk-live-secret-abcdefgh";
    const audit = new AuditLog(file, () => [secret]);
    audit.record("approval.requested", { tool: "workspace.write", args: `{"apiKey":"${secret}"}`, nested: { password: "hunter2" } });
    audit.record("tool.completed", { tool: "workspace.write", bytes: 128 });

    const lines = await audit.tail(10);
    expect(lines).toHaveLength(2);
    expect((await audit.tail(1000)).length).toBe(2);
    expect(lines[0]).toContain("\"event\":\"approval.requested\"");
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[1]).toContain("\"bytes\":128");

    const raw = await readFile(file, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(raw).not.toContain(secret);
  });

  it("rotates the log instead of growing without bound", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-audit-rotate-"));
    const file = path.join(directory, "audit.log");
    const audit = new AuditLog(file, () => [], 120);
    audit.record("first", { payload: "a".repeat(120) });
    audit.record("second", { payload: "b".repeat(120) });
    const lines = await audit.tail(10);
    expect(lines.some((line) => line.includes("\"event\":\"second\""))).toBe(true);
    const previous = await readFile(`${file}.1`, "utf8").catch(() => "");
    expect(previous).toContain("\"event\":\"first\"");
  });

  it("returns an empty tail when the log does not exist yet", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openhack-audit-empty-"));
    const audit = new AuditLog(path.join(directory, "missing.log"), () => []);
    expect(await audit.tail(5)).toEqual([]);
    expect(redact("")).toBe("");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson([1, "two"])).toBe('[1,"two"]');
  });
});
