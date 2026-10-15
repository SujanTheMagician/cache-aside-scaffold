import { redis } from "../redis.js";

/**
 * Cache keys and invalidation rules — ONE source of truth.
 *
 * Every write that changes a cached read is handled here (not scattered across
 * controllers), so the read keys and the rules that clear them can't drift apart.
 *
 * Feed strategy: VERSION COUNTER (no KEYS).
 *   Every feed key embeds the current `posts:feed:ver`. A new post does one
 *   O(1) INCR, so every page/sort combination is retired at once — readers
 *   immediately build keys under the new version. The orphaned old-version keys
 *   are never read again and simply expire via their TTL.
 */
const FEED_VERSION_KEY = "posts:feed:ver";

export const keys = {
  feed: async (page, sort) => {
    const ver = (await redis.get(FEED_VERSION_KEY)) ?? "0";
    return `posts:feed:v${ver}:page=${page}:sort=${sort}`;
  },
  user: (id) => `user:${id}`,
};

export const invalidate = {
  // POST /posts — retire every cached feed page with a single INCR.
  // The author's profile embeds their posts, so clear that one user too.
  onNewPost: async (authorId) => {
    await redis.incr(FEED_VERSION_KEY);
    if (authorId) await redis.del(keys.user(authorId));
  },
  // PUT /users/:id — clear ONLY this user's cached profile.
  onProfileEdit: async (userId) => {
    await redis.del(keys.user(userId));
  },
};
