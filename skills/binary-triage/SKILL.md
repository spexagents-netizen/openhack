---
name: binary-triage
description: First pass on an unknown native binary — what it is, what it talks to, what protects it, and what to hand to a disassembler.
---

# Binary triage

Ten minutes to a profile, never a full reverse. The output decides whether to keep going.

## 1. Identity
```bash
file target; sha256sum target
```
Record the hash first. Every claim later is tied to it.

## 2. Headers and imports
Look at: architecture, subsystem (GUI vs console), linker, timestamp, packer sections (`.UPX`, high entropy, odd names), TLS callbacks, and the import table. Imports alone tell you the story: `WinHttp`/`socket` = network, `Crypt*` = crypto, `CreateRemoteThread`/`VirtualAllocEx` = injection, `RegOpenKey` = persistence.

## 3. Strings, filtered
```bash
strings -n 8 target | sort -u
```
Keep: URLs, hosts, user agents, registry paths, error templates, mutexes, PDB paths. A PDB path is a build machine, a username, and often a symbol server.

## 4. Entropy and packing
High entropy in `.text` with few imports means packed. Do not analyze the packer's output; unpack first. If it is UPX, `upx -d` and compare. If it is Themida/VMProtect, note it and stop — that is a separate job.

## 5. Network and config extraction
- `web_search` the hosts to see whose infrastructure it is.
- Look for a config blob: a base64 string, a JSON template, an encrypted resource. Cross-reference with the strings.
- Sample traffic on a VM with a fake proxy: what does it POST, how often, with what beacon jitter.

## 6. Hand off
Produce a profile: hash, type, protection, imports of interest, hosts, config location, and three hypotheses ranked by evidence. If it needs disassembly, `tool_search "native disassembly function decompile"` and use the RE backend rather than guessing.

## Rules
- Static before dynamic. Run it only in a disposable VM, never on the bench host.
- Never claim a capability from a string alone. A string is a hint; the call site is proof.
- Keep every artifact (hash, strings dump, import list) as evidence.
