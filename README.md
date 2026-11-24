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

Buy a coin at its launch, but only launches that do not smell like a
rug. A fresh curve moves most in its first seconds, so the bot watches
each CreateEvent and takes one small stake of 0.08 SOL (capped at 1% of
the curve's real SOL reserve, never below 0.01 SOL) when the launch
passes the filter: the creator has not sold, the creator bought a little
in the create slot (at least 0.02 SOL, at most 2 SOL — skin in the game,
not a load-up before a dump), and 3 to 5 distinct outside wallets have
bought in the first few slots. No re-entries, one stake per coin.

It sells the whole position on the first of: value at 1.25x cost, value
at 0.88x cost, a trailing stop once the position ran 20% up (sell on a
15% give-back from the peak), the creator selling, or 15 slots held.
Small stakes and fast exits keep at most five slots busy, so the bot
rotates through many launches across the six-hour window instead of
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
