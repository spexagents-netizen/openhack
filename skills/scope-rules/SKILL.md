---
name: scope-rules
description: Read a bug bounty program's scope and rules before any packet, and decide what is in, what is out, and what would get the report rejected.
---

# Scope and rules

Do this before recon. It is the cheapest step and the one that ends engagements.

## Extract, do not summarize
From the program page, copy verbatim:
- **In scope**: exact domains, wildcards, app stores, IP ranges, source repos, hardware.
- **Out of scope**: the same list for the other direction. Wildcards usually exclude some subdomains explicitly.
- **Prohibited actions**: automated scanning, brute force, DoS, social engineering, physical, third-party tenants.
- **Data rules**: how much data you may access, whether you may store it, how to destroy it.
- **Disclosure**: private by default, coordinated window, whether public write-ups are allowed.

## Turn it into a decision list
Write one line per rule:

```
IN  : *.target.com, api.target.com, iOS app id 1234
OUT : status.target.com, blog.target.com, any *.target.dev
NO  : scanners, brute force, DoS, phishing staff
DATA: stop at first proof, delete within 24h, report fragment only
```

## Enforcement
- Every host you touch must match an `IN` line and no `OUT` line. Check the wildcard expansion, not the pattern.
- Before a request that could be noisy, re-read the prohibited list. A scanner against a "no automated scanning" program is a ban, not a finding.
- If a target is a shared service (SaaS with tenants), test only your own tenant and say so.

## When the program is vague
Ask the program owner through their stated channel, or pick the conservative reading and write it in the report. "The rules were unclear" is not a defense.

## Output
A scope block at the top of the session's notes, and a one-line justification in every finding: which scope line authorized this target.
