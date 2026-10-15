---
uid: 01KVFN5D80AACSP2ZRPKRAX2MV
type: project-note
project: trading-bot
status: active
source: manual
verified: false
created: '2026-06-19T10:00:00.000Z'
updated: '2026-06-19T10:00:00.000Z'
tags:
  - risk
---

## What it does

A single halt switch in front of order submission. When it trips, new orders are rejected and
open positions are left alone — it stops the bot digging, it does not liquidate.

## Trip conditions

- Daily drawdown over 4%, measured against the 00:00 UTC mark.
- Three consecutive rejected orders from the exchange.
- Any position exceeding the leverage cap in [[Leverage allowed up to 2x]].

## Reset

Manual only. An automatic reset would defeat the purpose — if it tripped, a human should look
at why before the bot trades again.
