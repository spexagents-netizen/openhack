---
name: injection-proof
description: Prove SQL injection, XSS and SSRF without guessing — payload, discriminating response, and out-of-band confirmation when the bug is blind.
---

# Injection proof

An injection finding needs a payload and a response that could not happen otherwise. "The quote broke the page" is not proof.

## SQL injection
1. **Confirm the parameter is live**: single quote, then a comment form appropriate to the DB (`-- `, `#`, `/**/`).
2. **Discriminate**: a true condition and a false condition must differ.
   `' AND 1=1-- ` vs `' AND 1=2-- ` — same length, different body.
3. **Fingerprint**: error text, `@@version`, `version()`, `sqlite_version()`. DBMS decides the exploitation path.
4. **Extract, minimally**: one row, one column, then stop. Prove the database is readable, do not dump it.
5. **Blind**: time-based (`SLEEP(5)`, `pg_sleep(5)`, `WAITFOR DELAY`) measured three times, or out-of-band via OAST.

## XSS
1. Find the reflection or the sink: HTML body, attribute, JS string, `innerHTML`, `document.write`.
2. Match the context. `<script>` in an attribute does nothing; break out with the right quote first.
3. Prove execution, not reflection: an alert-equivalent that fires in the browser pane, or a callback to your OAST host.
4. Stored: show the write path and the read path with two identities, or two sessions if the app is single-user.

## SSRF
1. Point the parameter at a controlled host first. A callback proves the server made the request.
2. Escalate in order: internal IP:port, cloud metadata (`169.254.169.254`), then protocol handlers (`file://`, `gopher://`).
3. Blind is the common case: OAST host, then a timing side channel for internal ports.
4. Stop at proof. Do not read credentials beyond the minimum needed to demonstrate access.

## Out-of-band
When the response gives nothing, the callback is the finding. Generate a unique host per test so the hit is attributable, and keep the request log as evidence.

## Rules
- One payload per hypothesis. Batch payloads hide which one worked.
- Never run a fuzzer against production without the program's written permission.
- A WAF blocking your payload is not a dead end; it is information about what to encode next.
