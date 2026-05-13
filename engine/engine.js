// Otuburu demo engine.
// Maintains a single demo account, a position book, an open digital-option book,
// applies mark-to-market on every tick, settles at stop-out / TP / expiry,
// and exposes house-edge statistics.
//
// This is the local proof-of-concept of the Rust engine described in §5 of the plan.

const { EventEmitter } = require('events');
const { bus: feedBus } = require('./generators');

class EngineBus extends EventEmitter {}
const bus = new EngineBus();

// ----- account state -----
const STARTING_BALANCE = 10_000;
const account = {
  id: 'demo-1',
  currency: 'USD',
  balance: STARTING_BALANCE,
  realisedPnl: 0,
};

// ----- house state -----
const house = {
  totalSpreadCaptured: 0,
  totalPayoutMargin: 0,    // expected edge collected from binary mispricing
  totalClientPnl: 0,        // sum of client P&L (negative = house wins)
  binaryCount: 0,
  binaryWins: 0,
  cfdCount: 0,
};

// ----- positions (CFDs) -----
let nextPosId = 1;
const positions = new Map(); // id -> position

// ----- digital options -----
let nextBinId = 1;
const binaries = new Map(); // id -> binary

// ----- live quotes -----
const quotes = new Map(); // symbol -> last tick

// Contract size per symbol (notional per lot)
const contractSize = {
  BOOM1000: 1, BOOM500: 1, CRASH1000: 1,
  frxEURUSD: 100_000, frxGBPUSD: 100_000,
  cryBTCUSD: 1, cryETHUSD: 1,
};

// Leverage policy per symbol
const leverage = {
  BOOM1000: 100, BOOM500: 100, CRASH1000: 100,
  frxEURUSD: 500, frxGBPUSD: 500,
  cryBTCUSD: 50, cryETHUSD: 50,
};

// Used margin across open positions
function usedMargin() {
  let m = 0;
  for (const p of positions.values()) m += p.margin;
  return m;
}
function equity() {
  let unreal = 0;
  for (const p of positions.values()) unreal += p.unrealisedPnl;
  return account.balance + unreal;
}
function freeMargin() {
  return equity() - usedMargin();
}
function marginLevel() {
  const u = usedMargin();
  return u === 0 ? Infinity : (equity() / u) * 100;
}

// ----- CFD: open / close -----
function placeCfdOrder({ symbol, side, lots }) {
  const q = quotes.get(symbol);
  if (!q) return { error: 'no quote yet for ' + symbol };
  if (!(side === 'BUY' || side === 'SELL')) return { error: 'side must be BUY or SELL' };
  if (!Number.isFinite(lots) || lots <= 0) return { error: 'lots must be positive' };

  const entry = side === 'BUY' ? q.ask : q.bid;
  const notional = lots * (contractSize[symbol] || 1) * entry;
  const margin = notional / (leverage[symbol] || 100);
  if (margin > freeMargin()) return { error: 'insufficient free margin' };

  const spreadCost = lots * (contractSize[symbol] || 1) * (q.ask - q.bid);
  house.totalSpreadCaptured += spreadCost;
  house.cfdCount++;

  const pos = {
    id: nextPosId++,
    symbol, side, lots,
    entry, margin, notional,
    unrealisedPnl: 0,
    ts: Date.now(),
  };
  positions.set(pos.id, pos);
  bus.emit('position-open', pos);
  return { position: pos };
}

function closeCfd(id) {
  const p = positions.get(id);
  if (!p) return { error: 'no such position' };
  const q = quotes.get(p.symbol);
  if (!q) return { error: 'no quote' };
  const exit = p.side === 'BUY' ? q.bid : q.ask;
  const pnl = pnlFor(p, exit);
  account.balance += pnl;
  account.realisedPnl += pnl;
  house.totalClientPnl += pnl;
  positions.delete(id);
  bus.emit('position-close', { ...p, exit, pnl });
  return { closed: { ...p, exit, pnl } };
}

function pnlFor(p, mark) {
  const dir = p.side === 'BUY' ? 1 : -1;
  return dir * (mark - p.entry) * p.lots * (contractSize[p.symbol] || 1);
}

// ----- Digital options (Rise/Fall) -----
// We price digitally: fair_payout ≈ 1 / 0.5 = 2.0 for a symmetric coin-flip-style contract,
// then offer a slightly worse multiplier (e.g. 1.85) so house edge ≈ (2.0 - 1.85)/2 = 7.5%.
const PAYOUT_MULTIPLIER = 1.85; // fair = 2.0, edge ≈ 7.5%
const BINARY_HOUSE_EDGE = (2.0 - PAYOUT_MULTIPLIER) / 2.0;

function placeBinary({ symbol, direction, stake, ticks }) {
  const q = quotes.get(symbol);
  if (!q) return { error: 'no quote' };
  if (!['UP', 'DOWN'].includes(direction)) return { error: 'direction must be UP or DOWN' };
  if (!Number.isFinite(stake) || stake <= 0) return { error: 'stake must be positive' };
  if (!Number.isInteger(ticks) || ticks <= 0 || ticks > 200) return { error: 'ticks 1..200' };
  if (stake > account.balance) return { error: 'insufficient balance' };

  account.balance -= stake;
  house.binaryCount++;
  house.totalPayoutMargin += stake * BINARY_HOUSE_EDGE;

  const b = {
    id: nextBinId++,
    symbol, direction, stake, ticksLeft: ticks, ticksTotal: ticks,
    entry: q.mid,
    multiplier: PAYOUT_MULTIPLIER,
    ts: Date.now(),
  };
  binaries.set(b.id, b);
  bus.emit('binary-open', b);
  return { binary: b };
}

function settleBinaries(symbol, lastMid) {
  for (const b of [...binaries.values()]) {
    if (b.symbol !== symbol) continue;
    b.ticksLeft--;
    if (b.ticksLeft <= 0) {
      const won = (b.direction === 'UP' && lastMid > b.entry) ||
                  (b.direction === 'DOWN' && lastMid < b.entry);
      const payout = won ? b.stake * b.multiplier : 0;
      account.balance += payout;
      house.totalClientPnl += (payout - b.stake);
      if (won) house.binaryWins++;
      binaries.delete(b.id);
      bus.emit('binary-settled', { ...b, exit: lastMid, won, payout });
    }
  }
}

// ----- tick handler: MTM + stop-out + binary expiry -----
feedBus.on('tick', (t) => {
  quotes.set(t.symbol, t);
  // Mark to market open CFDs on this symbol
  for (const p of positions.values()) {
    if (p.symbol !== t.symbol) continue;
    const mark = p.side === 'BUY' ? t.bid : t.ask;
    p.unrealisedPnl = pnlFor(p, mark);
  }
  // Stop-out at 50% margin level
  if (marginLevel() < 50) {
    let worst = null;
    for (const p of positions.values()) {
      if (!worst || p.unrealisedPnl < worst.unrealisedPnl) worst = p;
    }
    if (worst) closeCfd(worst.id);
  }
  // Settle expiring binaries
  settleBinaries(t.symbol, t.mid);
  bus.emit('tick', t);
});

// ----- snapshots & stats -----
function snapshot() {
  return {
    account: {
      ...account,
      equity: round(equity()),
      usedMargin: round(usedMargin()),
      freeMargin: round(freeMargin()),
      marginLevel: round(marginLevel()),
    },
    positions: [...positions.values()],
    binaries: [...binaries.values()],
    quotes: Object.fromEntries(quotes),
    house: {
      ...house,
      totalSpreadCaptured: round(house.totalSpreadCaptured),
      totalPayoutMargin: round(house.totalPayoutMargin),
      totalClientPnl: round(house.totalClientPnl),
      houseNet: round(-house.totalClientPnl), // house P&L = -client P&L
      binaryWinRate: house.binaryCount ? house.binaryWins / house.binaryCount : null,
      payoutMultiplier: PAYOUT_MULTIPLIER,
      expectedHouseEdge: BINARY_HOUSE_EDGE,
    },
  };
}
function round(x) {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

module.exports = {
  bus,
  placeCfdOrder, closeCfd,
  placeBinary,
  snapshot,
  account, house,
};
