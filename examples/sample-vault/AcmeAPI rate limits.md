---
uid: 01KWY0AB80Y15HYQG2KZXQCJZ1
type: reference
project: notes-app
status: active
source: manual
verified: true
created: '2026-07-07T10:00:00.000Z'
updated: '2026-07-07T10:00:00.000Z'
tags:
  - api
---

## Limits

AcmeAPI returns HTTP 429 once a client exceeds 600 requests per minute. The response carries a
`Retry-After` header in seconds; it is authoritative and should be preferred over any local
backoff calculation.

## SessionStore

The SessionStore endpoint is rate limited separately and much harder — 60 requests per minute,
counted per session token rather than per client. Batch reads instead of looping.

## What we do

Exponential backoff starting at the `Retry-After` value, capped at 60 seconds, with jitter.
Retries are logged but not alerted on unless three consecutive attempts fail.
