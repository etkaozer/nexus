---
uid: 01KS2D7V80NTAHBSTYAXDRT3MP
type: decision
project: trading-bot
status: superseded
source: manual
verified: true
superseded_by: 01KT916M805YSM7CM8N0KF3KHS
created: '2026-05-20T10:00:00.000Z'
updated: '2026-06-04T10:00:00.000Z'
tags:
  - risk
---

## Decision

The trading bot ships spot-only for the MVP. No margin, no leverage, no shorts.

## Why

Two reasons, both about keeping the failure modes countable:

- The risk envelope stays trivially bounded — the worst case is the position going to zero,
  which is a number we can state in advance.
- The kill-switch logic stays simple. With leverage there is a liquidation path to reason
  about on every code path that touches order submission.

## Revisit when

Paper trading has run clean for a month and the circuit breaker has actually fired at least
once in anger.
