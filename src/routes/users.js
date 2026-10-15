import { Router } from "express";
import { prisma, slowQuery } from "../db.js";
import { cached } from "../cache/cached.js";
import { invalidate, keys } from "../cache/invalidation.js";

// Profiles rarely change, and every edit deletes the key explicitly,
// so the TTL is only a safety net against missed invalidation.
const USER_TTL_S = 300;

const router = Router();

// READ: GET /users/:id
// Cached per user id (user:<id>) for USER_TTL_S.
router.get("/users/:id", async (req, res) => {
  const user = await cached(keys.user(req.params.id), USER_TTL_S, async () => {
    await slowQuery(); // simulates a heavy, disk-backed query
    return prisma.user.findUnique({
      where: { id: req.params.id },
      include: { posts: true },
    });
  });

  if (!user) return res.status(404).json({ error: "not found" });
  res.json(user);
});

// WRITE: PUT /users/:id  { name?, bio? }
// Invalidates ONLY this user's cached profile.
router.put("/users/:id", async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: req.body,
  });
  await invalidate.onProfileEdit(req.params.id);
  res.json(user);
});

export default router;
