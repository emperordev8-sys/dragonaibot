import { RESULTS } from '../core/constants.js';

const round2 = (v) => Math.round(v * 100) / 100;

// Performance statistics from a list of recorded signal results (chronological).
export function computeMetrics(results, startingBalance = 1000) {
  const decided = results.filter((r) => r.result === RESULTS.WIN || r.result === RESULTS.LOSS);
  const wins = decided.filter((r) => r.result === RESULTS.WIN).length;
  const losses = decided.length - wins;

  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let winStreak = 0;
  let loseStreak = 0;
  let curWin = 0;
  let curLose = 0;
  const equityCurve = [{ ts: results[0]?.entryTs ?? 0, equity: startingBalance }];

  for (const r of results) {
    equity += r.pnl;
    if (r.pnl > 0) grossProfit += r.pnl;
    if (r.pnl < 0) grossLoss += -r.pnl;
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (r.result === RESULTS.WIN) {
      curWin += 1;
      curLose = 0;
    } else if (r.result === RESULTS.LOSS) {
      curLose += 1;
      curWin = 0;
    }
    winStreak = Math.max(winStreak, curWin);
    loseStreak = Math.max(loseStreak, curLose);
    equityCurve.push({ ts: r.expirationTs ?? r.entryTs, equity: round2(equity) });
  }

  return {
    totalSignals: results.length,
    wins,
    losses,
    voids: results.filter((r) => r.result === RESULTS.VOID).length,
    invalid: results.filter((r) => r.result === RESULTS.INVALID).length,
    winRate: decided.length ? round2((wins / decided.length) * 100) : null,
    netResult: round2(equity - startingBalance),
    maxDrawdown: round2(maxDrawdown),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? null : 0) : round2(grossProfit / grossLoss), // null = no losses
    longestWinStreak: winStreak,
    longestLoseStreak: loseStreak,
    equityCurve,
  };
}

// Win rate needed just to break even at a given payout (e.g. 85% -> ~54.05%).
export function breakEvenWinRate(payoutPct) {
  return round2((100 / (100 + payoutPct)) * 100);
}
