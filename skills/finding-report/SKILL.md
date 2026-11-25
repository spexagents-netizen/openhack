---
name: finding-report
description: Turn a proven bug into a report a triager accepts on first read: title, impact, reproduction, evidence, fix, severity.
---

# Finding report

A report is judged in the first fifteen seconds. Lead with the bug, not the journey.

## Skeleton

```
Title: <component> <bug class> allows <actor> to <impact>

Summary
One paragraph. What is broken, who can exploit it, what they get.

Impact
Concrete: "any authenticated user can read any other tenant's invoices,
including billing address and card last-4". Not "confidentiality is impacted".

Severity
CVSS 3.1 vector + score, and the program's own band if it has one.

Steps to reproduce
1. Sign in as account A (attacker@...), create resource X.
2. Capture the request: <method> <url>, body, headers.
3. Sign in as account B (victim@...), note victim object id.
4. Replay the request from step 2 with A's token and B's id.
5. Observe 200 + B's data.

Evidence
- request.txt / response.txt, raw, both identities
- the differentiating response body, redacted to the minimum
- one screenshot only if it adds what the raw text cannot

Root cause
The check that is missing or wrong, in one or two sentences.

Remediation
Specific: "authorize object access against the session subject before lookup",
not "improve security".

Notes
Scope line that authorized the target. Data handling. Disclosure preferences.
```

## Rules that get reports rejected
- Steps that only work in your environment. Pin the account, the ids, the timing.
- A screenshot of a JSON body instead of the raw request. Triagers replay requests.
- Claiming broader impact than you proved. One tenant is one tenant.
- No fix. A concrete remediation shortens triage and raises severity confidence.

## Before you submit
- Replay every step from a clean session. If step 3 fails, the report fails.
- Check for duplicates: search the program's disclosed reports and the issue tracker.
- Redact secrets, tokens and other users' data to the minimum that still proves it.
