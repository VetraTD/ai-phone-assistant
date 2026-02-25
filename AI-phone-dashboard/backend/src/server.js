require("dotenv").config();

const express = require("express");
const cors = require("cors");

// ✅ DB pool (make sure src/db/index.js exports the pool)
const pool = require("./db");

const app = express();

app.use(cors());
app.use(express.json());

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({
    status: "running",
    service: "dashboard-backend",
  });
});

// ✅ DB connection test
app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Pull 5 most recent calls (to prove you're reading friend's data)
app.get("/api/calls", async (req, res) => {
  try {
    const { business_id } = req.query;

    const sql = business_id
      ? "select * from calls where business_id = $1 order by started_at desc limit 50"
      : "select * from calls order by started_at desc limit 50";

    const params = business_id ? [business_id] : [];
    const r = await pool.query(sql, params);

    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("Dashboard backend running on port " + PORT);
});