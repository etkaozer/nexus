---
uid: 01KT916M805YSM7CM8N0KF3KHS
type: decision
project: trading-bot
status: active
source: manual
verified: true
supersedes: 01KS2D7V80NTAHBSTYAXDRT3MP
created: '2026-06-04T10:00:00.000Z'
updated: '2026-06-04T10:00:00.000Z'
tags:
  - risk
---

## Decision

Leverage up to 2x is now permitted, on majors only. This replaces the earlier spot-only rule.

## Why it changed

Paper trading ran for six weeks without a single unexplained fill, and the circuit breaker
fired twice and halted correctly both times. The original objection was that liquidation
paths were unreviewed — they now are.

## Limits

- 2x maximum, and only on BTC and ETH.
- The circuit breaker halts all new orders at a 4% daily drawdown, leverage included.
- Anything above 2x, or on an altcoin, needs a new decision note — not an exception.
