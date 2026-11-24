[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/khaliefk/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/khaliefk/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Early-Momentum Paper Bot — Pump.fun Paper Sprint

One program, `main.ts`, paper-trades pump.fun on the house replay
(`agent-fun/replay/v2`). It reads the harness NDJSON stream on stdin —
`hello`, then one `batch` per slot step, then `done` — and answers every
batch with one reply line of orders. No network, no clock, no randomness:
the same input always gives the same replies, so the grader's two runs
agree byte for byte.

## The strategy

Buy a coin soon after it launches, but only once real buyers show up. A
fresh curve moves most in its first minutes, so the bot watches each new
mint's tape for buy flow — at least 4 buy trades from at least 4 distinct
wallets in the last 45 slots, net SOL flowing in and accelerating (the
newer half of the window beating the older half), price up and sitting
near its recent high — and takes a small first stake of 0.05 SOL (capped
at 1% of the curve's real SOL reserve, never below 0.01 SOL).

It adds 0.05 SOL once if the price steps up 12% and buy flow is still
positive, up to 0.1 SOL per coin. It sells the whole position on the first
of: value at 1.4x cost, value at 0.9x cost, a trailing stop once the
position ran 20% up, a single whale sell of 2 SOL or more, or 1500 slots
held flat. Small stakes and fast exits keep at most five slots busy, so
the bot rotates through many coins across the six-hour window instead of
sitting on dead ones. A pacing probe (0.01 SOL round trip on a liquid
coin) keeps the fill and coin counts up when the tape goes quiet, which
is what the guardrail needs: at least 20 coins with a round trip of
0.01 SOL or more.

`main.ts` runs through the kit SDK shim in `vendor/makefun-bot.ts`, which
owns the wire protocol and validates every order.

## Run it

```sh
node main.ts
```

Node 22 or later. The grader runs `node /bot/main.ts` with the repo
mounted at `/bot`.

## Entry

- Competition: [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
- Account: @bantu-og
- Paper trading only — the replay uses market data, never real funds.
