import { Router } from "express";
import { prisma, slowQuery } from "../db.js";
import { cached } from "../cache/cached.js";
import { invalidate, keys } from "../cache/invalidation.js";

// Feed changes constantly, but a minute of staleness is invisible to readers
// (and new posts invalidate it immediately anyway).
const FEED_TTL_S = 60;

const router = Router();

// READ (hot): GET /posts/feed?page=1&sort=new|hot
// Cached per (feed version, page, sort) for FEED_TTL_S.
router.get("/posts/feed", async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const sort = req.query.sort === "hot" ? "hot" : "new";

  const key = await keys.feed(page, sort);
  const feed = await cached(key, FEED_TTL_S, async () => {
    await slowQuery(); // simulates a heavy, disk-backed query
    return prisma.post.findMany({
      orderBy: sort === "hot" ? { likes: "desc" } : { createdAt: "desc" },
      skip: (page - 1) * 20,
      take: 20,
      include: { author: true },
    });
  });

  res.json(feed);
});

// WRITE: POST /posts  { title, body, authorId }
// Invalidates every feed page (and the author's cached profile).
router.post("/posts", async (req, res) => {
  const post = await prisma.post.create({ data: req.body });
  await invalidate.onNewPost(post.authorId);
  res.status(201).json(post);
});

export default router;
