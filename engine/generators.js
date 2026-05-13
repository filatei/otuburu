// Synthetic price-feed generators for Otuburu demo.
// One generator per symbol. Each emits ticks with monotonic timestamps.
// Generators are deterministic given (seed, tick index).
//
// Mapping to the Architecture & Tech Plan:
//   §8.2 Boom/Crash         — bounded RW + Poisson spike
//   §8.3 Synthetic FX/Crypto — GBM with mean-reversion anchor (Heston-lite)

const { EventEmitter } = require('events');
const { mulberry32, gaussian, poissonEvent } = require('./rng');

class FeedBus extends EventEmitter {}
const bus = new FeedBus();

// --- Boom / Crash ---
// Boom: positive spikes; Crash: negative spikes.
// `lambdaPerTick` is the expected inverse of mean ticks between spikes.
function makeBoomCrash({ symbol, seed, startPrice, sigmaSmall, spikeMean, spikeStd, spikeDirection, lambdaPerTick }) {
  const rand = mulberry32(seed);
  let price = startPrice;
  let tickIndex = 0;

  return function nextTick() {
    tickIndex++;
    // small random walk
    price += sigmaSmall * gaussian(rand);
    // spike
    if (poissonEvent(rand, lambdaPerTick)) {
      const mag = spikeMean + spikeStd * Math.abs(gaussian(rand));
      price += spikeDirection * mag;
    }
    // soft bound — Boom/Crash drifts gently towards startPrice over very long horizons
    price += 0.0005 * (startPrice - price);
    if (price < 1) price = 1; // safety
    return tick(symbol, price, 0.5); // 0.5 spread
  };
}

// --- Synthetic FX (Heston-lite) ---
// dS = mu*S*dt + sqrt(v)*S*dW1
// dv = kappa*(theta - v)*dt + xi*sqrt(v)*dW2
function makeFxFeed({ symbol, seed, anchor, mu, theta, kappa, xi, rho, dt, spreadPips, pipSize }) {
  const rand = mulberry32(seed);
  let S = anchor;
  let v = theta;
  return function nextTick() {
    const z1 = gaussian(rand);
    const z2 = rho * z1 + Math.sqrt(1 - rho * rho) * gaussian(rand);
    const vClamped = Math.max(v, 1e-8);
    S = S * Math.exp((mu - 0.5 * vClamped) * dt + Math.sqrt(vClamped * dt) * z1);
    v = Math.max(0, v + kappa * (theta - v) * dt + xi * Math.sqrt(vClamped * dt) * z2);
    // soft pull to anchor so the synthetic feed cannot drift unboundedly
    S += 0.00002 * (anchor - S);
    return tick(symbol, S, spreadPips * pipSize);
  };
}

// --- Synthetic Crypto (GBM with regime-switching vol) ---
function makeCryptoFeed({ symbol, seed, anchor, mu, baseVol, highVol, regimeFlipProb, dt, spreadBps }) {
  const rand = mulberry32(seed);
  let S = anchor;
  let regime = 'calm';
  return function nextTick() {
    if (rand() < regimeFlipProb) regime = regime === 'calm' ? 'storm' : 'calm';
    const sigma = regime === 'calm' ? baseVol : highVol;
    const z = gaussian(rand);
    S = S * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
    // anchor pull
    S += 0.00001 * (anchor - S);
    const spread = (spreadBps / 10000) * S;
    return tick(symbol, S, spread);
  };
}

function tick(symbol, mid, spread) {
  return {
    symbol,
    ts: Date.now(),
    mid: round(mid, 6),
    bid: round(mid - spread / 2, 6),
    ask: round(mid + spread / 2, 6),
  };
}
function round(x, dp) { const f = 10 ** dp; return Math.round(x * f) / f; }

// Wire up the symbols we ship at launch (Phase 1 selection from the plan).
const generators = {
  // Boom / Crash: index lives around 1000, small walk in 0.1, spikes of ~30 with Poisson lambda
  BOOM1000: makeBoomCrash({
    symbol: 'BOOM1000', seed: 11,
    startPrice: 1000, sigmaSmall: 0.15, spikeMean: 25, spikeStd: 10,
    spikeDirection: +1, lambdaPerTick: 1 / 1000,
  }),
  CRASH1000: makeBoomCrash({
    symbol: 'CRASH1000', seed: 13,
    startPrice: 1000, sigmaSmall: 0.15, spikeMean: 25, spikeStd: 10,
    spikeDirection: -1, lambdaPerTick: 1 / 1000,
  }),
  BOOM500: makeBoomCrash({
    symbol: 'BOOM500', seed: 17,
    startPrice: 1000, sigmaSmall: 0.18, spikeMean: 20, spikeStd: 8,
    spikeDirection: +1, lambdaPerTick: 1 / 500,
  }),
  // Synthetic FX: EUR/USD style
  frxEURUSD: makeFxFeed({
    symbol: 'frxEURUSD', seed: 23,
    anchor: 1.0850, mu: 0.0, theta: 0.06 * 0.06,
    kappa: 2.0, xi: 0.30, rho: -0.4, dt: 1 / (252 * 24 * 60 * 60),
    spreadPips: 1.0, pipSize: 0.0001,
  }),
  frxGBPUSD: makeFxFeed({
    symbol: 'frxGBPUSD', seed: 29,
    anchor: 1.2650, mu: 0.0, theta: 0.07 * 0.07,
    kappa: 2.0, xi: 0.32, rho: -0.4, dt: 1 / (252 * 24 * 60 * 60),
    spreadPips: 1.2, pipSize: 0.0001,
  }),
  // Synthetic Crypto
  cryBTCUSD: makeCryptoFeed({
    symbol: 'cryBTCUSD', seed: 31,
    anchor: 63000, mu: 0.0, baseVol: 0.6, highVol: 1.2,
    regimeFlipProb: 0.002, dt: 1 / (365 * 24 * 60 * 60), spreadBps: 8,
  }),
  cryETHUSD: makeCryptoFeed({
    symbol: 'cryETHUSD', seed: 37,
    anchor: 3200, mu: 0.0, baseVol: 0.7, highVol: 1.4,
    regimeFlipProb: 0.002, dt: 1 / (365 * 24 * 60 * 60), spreadBps: 10,
  }),
};

// Each symbol publishes at its own cadence.
const cadenceMs = {
  BOOM1000: 1000, CRASH1000: 1000, BOOM500: 500,
  frxEURUSD: 500, frxGBPUSD: 500,
  cryBTCUSD: 500, cryETHUSD: 500,
};

function start() {
  for (const symbol of Object.keys(generators)) {
    const fn = generators[symbol];
    const ms = cadenceMs[symbol] || 1000;
    setInterval(() => {
      const t = fn();
      bus.emit('tick', t);
    }, ms);
  }
}

function symbols() { return Object.keys(generators); }

module.exports = { bus, start, symbols };
