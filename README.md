# Cache-Aside + Stampede Protection — 2-Endpoint Scaffold

A small **Express + Prisma** service with **two read-heavy endpoints** and **two write endpoints that affect them**. Your job: apply the **cache-aside** pattern with a **TTL**, **explicit invalidation**, and **stampede protection** — then prove the improvement under load.

It runs on **SQLite** (zero database setup) and adds a small artificial query delay (`SLOW_MS`, default 40ms) so caching produces a real, measurable win.

---

## The endpoints

| Endpoint | Kind | Affected by |
|---|---|---|
| `GET /posts/feed?page=&sort=new\|hot` | Read (hot) | `POST /posts` |
| `GET /users/:id` | Read | `PUT /users/:id` |
| `POST /posts` | Write | invalidates the feed |
| `PUT /users/:id` | Write | invalidates that user |

Every read is currently **uncached** and slow. Two files are **stubs for you to complete**:

- `src/cache/cached.js` — the cache-aside + `SET … NX EX` stampede helper.
- `src/cache/invalidation.js` — the single "invalidation rules" module.

---

## Setup

```bash
npm install
docker start redis-m4          # or your Redis; see .env.example for REDIS_URL
cp .env.example .env
npm run db:push                # create the SQLite schema
npm run seed                   # seed users + 40 posts (prints a user id to test)
npm start                      # http://localhost:3000
```

---

## Your tasks

1. **Implement `cached(key, ttl, fetcher)`** in `src/cache/cached.js` — cache-aside (get → hit/miss → set with TTL) **plus** the `SET "lock:"+key "1" "NX" "EX" 5` stampede lock (winner does the work; others sleep ~50ms and re-read).
2. **Wrap both reads** in `cached()` with a **parameter-aware key** and a **deliberate TTL**:
   - `GET /posts/feed` — key includes `page` and `sort`.
   - `GET /users/:id` — key includes the `:id`.
3. **Wire invalidation** in `src/cache/invalidation.js` and call it from the writes:
   - `POST /posts` → `invalidate.onNewPost()` clears the feed.
   - `PUT /users/:id` → `invalidate.onProfileEdit(id)` clears **only that user**.
4. **Handle the paginated feed** without `KEYS posts:feed:*` (it blocks single-threaded Redis). Pick one: a fixed feed key, a version counter, or an explicit dependency list — **and write your choice in the TTL/Invalidation section below.**
5. **Verify invalidation:** `AUTHOR_ID=<seeded id> npm run verify` — both checks must PASS.
6. **Load test before and after**, and paste the numbers into the "Results" section below.

---

## Load testing

With `wrk` (preferred) — the `--latency` flag adds the p50/p99 distribution:
```bash
wrk -t4 -c50 -d10s --latency http://localhost:3000/posts/feed
wrk -t4 -c50 -d10s --latency http://localhost:3000/users/<id>
```

No `wrk` (Windows-friendly stand-in — prints req/s and p50/p99):
```bash
node scripts/load.js /posts/feed 50 2000
node scripts/load.js /users/<id> 50 2000
```

Run each **before** caching (or against a cold cache) and **after** caching is warm.

---

## Fill this in (part of your submission)

### TTL reasoning

| Endpoint | TTL | Why (staleness tolerance) |
|---|---|---|
| `GET /posts/feed` | `60s` | The feed is the hottest read and changes constantly, so it gets a short TTL. A minute of staleness is invisible to readers, and new posts invalidate it immediately anyway, so the TTL mainly bounds memory for orphaned old-version pages. |
| `GET /users/:id` | `300s` | Profiles rarely change, and every edit explicitly deletes the key. The TTL is only a safety net in case an invalidation is ever missed, so a few minutes is fine. |

### Invalidation rules

All rules live in one module: `src/cache/invalidation.js`. It also owns the key builders, so the read keys and the rules that clear them can't drift apart.

| Write | Clears |
|---|---|
| `POST /posts` | `INCR posts:feed:ver`, which retires **every** feed page/sort combo in one O(1) command. It also `DEL user:<authorId>`, because a profile embeds that user's posts. |
| `PUT /users/:id` | `DEL user:<id>`, **only that user**. Verified: editing Bob leaves Alice's `user:<id>` key cached. |

Writes **delete** (or retire) keys, they never update them in place. The next read rebuilds from the database.

**How I handled the paginated feed (no `KEYS`):** I used a **version counter in the key**. Every feed key is
`posts:feed:v<ver>:page=<page>:sort=<sort>`, where `<ver>` is read from `posts:feed:ver`. `POST /posts` does a single
`INCR posts:feed:ver`, so readers immediately start building keys under the new version and every old page/sort
combination becomes unreachable at once. The orphaned old-version keys are never read again and simply expire after their
60s TTL. That's one O(1) command per write, with no `KEYS posts:feed:*` scan that would block single-threaded Redis for
every client, and no dependency list to maintain.

### Stampede protection

`cached(key, ttl, fetcher)` in `src/cache/cached.js` is cache-aside plus a lock:

1. `GET key`. On a hit it returns the parsed JSON with no DB call.
2. On a miss, it tries `SET lock:<key> 1 NX EX 5`.
   - **Winner:** runs `fetcher()`, does `SET key <json> EX ttl`, and releases the lock (in a `finally`, so a failed fetch doesn't hold it).
   - **Everyone else:** sleeps 50ms and re-reads the cache, up to about 1s, instead of piling onto the DB. If the winner died, it falls back to `fetcher()` so the request still succeeds. The `EX 5` means a crashed winner's lock can't wedge the key.

### Results (before → after)

Measured on Windows with the cross-platform harness, `node scripts/load.js <path> 50 2000` (50 concurrent, 2000 requests),
`SLOW_MS=40`. "Before" is the untouched scaffold (stub `cached()` = no caching). "After" is the same command with the cache warm.

| Endpoint | req/s before | req/s after | p50 before → after | p99 before → after |
|---|---|---|---|---|
| `GET /posts/feed` | 843 | 3221 (**3.8×**) | 48.3ms → 12.8ms | 125.3ms → 45.4ms |
| `GET /users/:id` | 866 | 3822 (**4.4×**) | 47.6ms → 11.2ms | 147.0ms → 35.3ms |

The p99/p50 gap shrank from about 77–99ms to about 24–33ms: the slow-query tail is gone once reads come from Redis. The
remaining latency is mostly the load generator and server sharing one modest Windows laptop (8 GB RAM, Node's
`fetch` client). A dedicated `wrk` box would show a larger multiplier.

**Invalidation check:**

```
> $env:AUTHOR_ID="<seeded id>"; npm run verify
PASS: feed fresh after first write
PASS: feed fresh after second write (invalidation works)
```

### Running it on Windows (PowerShell)

The scaffold doesn't load `.env` automatically, so set variables in the shell:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379"   # your Redis
npm run db:push; npm run seed
npm start
# second terminal:
$env:AUTHOR_ID = "<id printed by seed>"; npm run verify
node scripts/load.js /posts/feed 50 2000
node scripts/load.js /users/<id> 50 2000
```

(Run these from PowerShell or cmd. In Git Bash, MSYS rewrites `/posts/feed` into a Windows path, so prefix with `MSYS_NO_PATHCONV=1`.)

---

## Submit

Open a **Pull Request on your fork** containing: the completed `cached()` helper, both reads using it, invalidation wired into both writes, `KEYS`-free feed handling, and this README filled in with your TTL reasoning, invalidation rules, and before/after numbers. Submit the PR link.
