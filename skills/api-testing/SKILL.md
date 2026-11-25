---
name: api-testing
description: Find broken object-level authorization, privilege escalation and mass assignment in a JSON API — the bugs that actually pay.
---

# API testing

Most bounty money today is broken access control, not injection. Test authorization before anything exotic.

## Build the request set first
From `web-recon` you have endpoints. Turn each into an exact request: method, path, headers, body, and the role it needs. Keep a raw file per endpoint so a finding is replayable byte for byte.

## The five checks, in this order

1. **BOLA / IDOR** — take an object id you own, swap it for one belonging to another account, replay with *your* token. 200 with their data is the bug. Try: sequential ids, uuid from a second account, ids from a list endpoint, ids in nested fields.
2. **Privilege escalation** — repeat every admin request with a normal-user token. Check `GET /admin`, `PATCH /users/{id}`, and role fields inside otherwise-legal bodies.
3. **Mass assignment** — add fields the UI never sends: `"role":"admin"`, `"verified":true`, `"balance":9999`, `"ownerId":"<other>"`. Read back to confirm persistence, not just a 200.
4. **Auth gaps** — drop the `Authorization` header entirely on each endpoint. A 200 without a token is critical.
5. **Object ownership on writes** — move a resource between accounts: change `owner_id`, then read as the other account.

## Proof discipline
A finding is only real when you can show:
- the request, verbatim, in both the happy path and the broken path,
- the response that differs (their data, their balance, the elevated role),
- the identity used for each call (which token, which account).

Store both raw responses as evidence. Never screenshot only the final state; the difference is the proof.

## Where to go deeper
- GraphQL: introspection on, then query other users' nodes by id. Check field-level auth, not just resolver-level.
- Mobile API: the app's base URL often has weaker auth than the web. Pull it from the APK strings and test the same object ids.
- File download: a signed URL that does not bind to a user is BOLA with extra steps.

## Rules
- Only the accounts you created. Never another real user's data beyond the minimum needed to prove the bug, and say so in the report.
- Rate limit yourself; a broken authz check does not need a thousand requests.
