// Deterministic seeded RNG for the Otuburu demo.
// Production will use ChaCha20 (see Architecture & Tech Plan §8.1).
// This demo uses a Mulberry32 PRNG — sufficient for a local demo, NOT for production.

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function poissonEvent(rand, lambdaPerTick) {
  // Bernoulli approximation: at each tick, fire with probability lambdaPerTick.
  return rand() < lambdaPerTick;
}

module.exports = { mulberry32, gaussian, poissonEvent };
