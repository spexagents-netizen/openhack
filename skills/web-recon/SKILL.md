---
name: web-recon
description: Map a web target's real surface before touching it — hosts, live services, endpoints, parameters, auth boundaries, and where the money is.
---

# Web recon

Goal: a surface map you can act on, not a tool dump.

## 1. Scope first
Read the program's in-scope list and rules. Write the exact wildcard set down in the session. If a host is not listed, do not touch it. Out-of-scope traffic ends the engagement and the payout.

## 2. Passive before active
- `web_search` for `<target> site:github.com`, `<target> api documentation`, `site:*.target.com -www`.
- Look for leaked endpoints, staging hosts, Postman collections, mobile API bases.
- Collect tech: framework, auth provider, CDN, WAF. That decides which bugs are plausible before you send a packet.

## 3. Resolve and probe
For each candidate host, one request. Capture scheme, status, server header, title, redirect target.

```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url} %{content_type}\n" -m 10 https://host/
```

Keep concurrency at 5. One host at a time; measure before you widen.

## 4. Crawl authenticated
Open the browser pane, sign in as a normal user, then walk the app like a user: every menu, every form, every API call the interface makes. Record request/response pairs. The UI is documentation for the API.

## 5. Rank by payout
For each endpoint record: needs auth? object id in path or body? file upload? money movement? admin surface? The five highest by *object id + privilege boundary + money* are the day's work.

## 6. Stop and write it down
Produce one note: hosts, endpoints, auth model, ranked targets, and the evidence for each claim. This is the input to `api-testing`.

## Rules
- 5 requests/second per host unless the program states otherwise.
- Never point a scanner at a target you have not manually mapped.
- A login wall you cannot pass gets recorded, not brute-forced.
