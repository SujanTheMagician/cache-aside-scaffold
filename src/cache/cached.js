import { redis } from "../redis.js";

const LOCK_TTL_S = 5;      // lock auto-expires if the winner crashes mid-fetch
const WAIT_MS = 50;        // how long a loser sleeps before re-reading the cache
const MAX_WAITS = 20;      // ~1s of waiting before giving up and querying directly

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * cached(key, ttl, fetcher) — cache-aside with stampede protection.
 *
 *   1. GET key — on a HIT, parse and return (no DB).
 *   2. On a MISS, race for `SET lock:<key> 1 NX EX 5`:
 *      - the winner runs fetcher(), SETs the value with EX ttl, releases the lock;
 *      - everyone else sleeps ~50ms and re-reads the cache instead of hitting the DB.
 */
export async function cached(key, ttl, fetcher) {
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit);

  const lockKey = "lock:" + key;
  const got = await redis.set(lockKey, "1", "NX", "EX", LOCK_TTL_S);

  if (got) {
    try {
      const value = await fetcher();
      await redis.set(key, JSON.stringify(value), "EX", ttl);
      return value;
    } finally {
      await redis.del(lockKey);
    }
  }

  // Someone else is rebuilding this key — wait for their result rather than
  // piling onto the database.
  for (let i = 0; i < MAX_WAITS; i++) {
    await sleep(WAIT_MS);
    const again = await redis.get(key);
    if (again !== null) return JSON.parse(again);
  }

  // Winner is slow or crashed; fall back to the DB so this request still succeeds.
  return fetcher();
}
