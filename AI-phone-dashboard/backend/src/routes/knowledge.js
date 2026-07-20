const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { getBusinessIdForUser, buildUpdateFromWhitelist } = require("../utils");
const {
  KNOWLEDGE_FIELD_VALIDATORS,
  validateQuestion,
  validateAnswer,
  validateCategory,
  validatePriority,
} = require("../knowledgeValidation");
const { authSensitiveLimiter } = require("../middleware/rateLimiters");

// ---------------------------------------------------------------------------
// Knowledge base CRUD (business_knowledge — Q&A pairs injected into the AI
// prompt at call time). Business-ownership check mirrors the pattern used
// by /api/business/:id/settings and the other business-scoped endpoints:
// resolve the authenticated user's business_id via getBusinessIdForUser,
// then require every row touched to belong to it.
// ---------------------------------------------------------------------------

router.get("/api/knowledge", authenticate, async (req, res) => {
  try {
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const { businessId } = req.query;
    if (!businessId || businessId !== userBusinessId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const r = await pool.query(
      `SELECT * FROM business_knowledge WHERE business_id = $1 ORDER BY priority DESC, created_at ASC`,
      [businessId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error("knowledge list failed:", err);
    res.status(500).json({ error: "Failed to load knowledge base" });
  }
});

router.post("/api/knowledge", authSensitiveLimiter, authenticate, async (req, res) => {
  try {
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

    const { businessId, question, answer, category, priority } = req.body || {};
    if (!businessId || businessId !== userBusinessId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const q = validateQuestion(question);
    if (q.error) return res.status(400).json({ error: `question: ${q.error}` });
    const a = validateAnswer(answer);
    if (a.error) return res.status(400).json({ error: `answer: ${a.error}` });
    const c = validateCategory(category);
    if (c.error) return res.status(400).json({ error: `category: ${c.error}` });
    const p = validatePriority(priority);
    if (p.error) return res.status(400).json({ error: `priority: ${p.error}` });

    const r = await pool.query(
      `INSERT INTO business_knowledge (business_id, question, answer, category, priority)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [businessId, q.value, a.value, c.value, p.value]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error("knowledge create failed:", err);
    res.status(500).json({ error: "Failed to create knowledge entry" });
  }
});

router.put("/api/knowledge/:id", authSensitiveLimiter, authenticate, async (req, res) => {
  try {
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const { id } = req.params;

    const existing = await pool.query(`SELECT * FROM business_knowledge WHERE id = $1`, [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: "Knowledge entry not found" });
    }
    if (existing.rows[0].business_id !== userBusinessId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const built = buildUpdateFromWhitelist(KNOWLEDGE_FIELD_VALIDATORS, req.body);
    if (built.error) {
      return res.status(400).json({ error: built.error });
    }
    if (!built.setClauses.length) {
      return res.json(existing.rows[0]);
    }

    const params = [...built.params, id];
    const sql = `UPDATE business_knowledge SET ${built.setClauses.join(", ")} WHERE id = $${params.length} RETURNING *`;
    const r = await pool.query(sql, params);
    res.json(r.rows[0]);
  } catch (err) {
    console.error("knowledge update failed:", err);
    res.status(500).json({ error: "Failed to update knowledge entry" });
  }
});

router.delete("/api/knowledge/:id", authSensitiveLimiter, authenticate, async (req, res) => {
  try {
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const { id } = req.params;

    const existing = await pool.query(`SELECT business_id FROM business_knowledge WHERE id = $1`, [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: "Knowledge entry not found" });
    }
    if (existing.rows[0].business_id !== userBusinessId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await pool.query(`DELETE FROM business_knowledge WHERE id = $1`, [id]);
    res.status(204).end();
  } catch (err) {
    console.error("knowledge delete failed:", err);
    res.status(500).json({ error: "Failed to delete knowledge entry" });
  }
});

module.exports = router;
