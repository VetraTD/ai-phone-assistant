#!/usr/bin/env node
/**
 * Seed a tenant's business_knowledge rows.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * On 2026-09-03 the assistant told a caller "I've confirmed we accept Blue
 * Cross Blue Shield". No insurance information exists anywhere in that tenant;
 * no tool ran on the turn. It also offered a service the practice does not
 * provide, and told a caller what a stored appointment was for when the row
 * says only "dental appointment". See LVX66 and LVX59.
 *
 * The sourcing rule added to NON-NEGOTIABLE RULES stops it inventing. It cannot
 * make it USEFUL: a receptionist that answers "I'll check and take a message"
 * to every question a new patient asks is a different failure, and LVX67 is
 * what that sounds like — "what can I expect at that appointment?" got a
 * refusal on one call and a helpful answer on another, three hours apart.
 *
 * The knowledge base is the half that makes refusal affordable, and every piece
 * of it already existed and was empty: the table (migration 005), the read
 * (services/db.js fetchBusinessKnowledge), the prompt section
 * (services/gemini.js === KNOWLEDGE BASE ===), and the Live-path fetch
 * (lib/voice/live/index.js). Nothing wrote rows outside the dashboard, so a
 * local rig had no way to populate one.
 *
 * ---------------------------------------------------------------------------
 * What it will and will not touch
 * ---------------------------------------------------------------------------
 *
 * business_knowledge, for one business, and nothing else. Same posture as
 * scripts/import-tenant.js: personal data is not this script's business.
 * It refuses to run against a database whose URL does not look local unless
 * --confirm is passed, because seeding a real tenant's answers is an operator
 * decision and not a developer convenience.
 *
 * Usage:
 *   DATABASE_URL=postgres://vetra:vetra_local_dev@localhost:55432/vetra \
 *     node scripts/seed-knowledge.js --phone +18176011171
 *   node scripts/seed-knowledge.js --phone +18176011171 --file my-rows.json
 *   node scripts/seed-knowledge.js --phone +18176011171 --replace
 *
 * --file    JSON array of { question, answer, category?, priority? }.
 *           Defaults to the Brightwork set below.
 * --replace Delete this business's existing rows first. Default is to add.
 * --confirm Required when DATABASE_URL is not obviously a local dev database.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

/**
 * Brightwork Family Dental — the local rig's demo tenant.
 *
 * Written to answer the questions actually asked on the six calls of
 * 2026-09-03, including the two that produced inventions. The insurance answer
 * is deliberately a NON-answer: the right response to "do you take my
 * insurance?" from a receptionist who has not been given a list is to say so
 * and offer to find out, which is precisely what was not done.
 */
const BRIGHTWORK = [
  {
    question: "Do you take my insurance? Which insurance providers do you accept?",
    answer:
      "I'm not able to confirm insurance over the phone — I don't want to tell you something that turns out to be wrong when you arrive. I can take your name and number and have the front desk check your plan and call you back.",
    category: "billing",
    priority: 100,
  },
  {
    question: "What services do you offer?",
    answer:
      "We're a general and family dental practice: check-ups, cleanings, fillings, crowns, and emergency toothache appointments.",
    category: "services",
    priority: 90,
  },
  {
    question: "Do you do Invisalign, clear aligners, braces, or orthodontics?",
    answer:
      "No, we don't offer orthodontic treatment — no braces and no clear aligners of any kind, including Invisalign. For that you'd need an orthodontist.",
    category: "services",
    priority: 90,
  },
  {
    question: "Do you do cosmetic work — whitening, veneers, implants?",
    answer:
      "Not at this practice. We stick to general and family dentistry: check-ups, cleanings, fillings, crowns and emergencies.",
    category: "services",
    priority: 80,
  },
  {
    question: "What happens at a check-up? What should I expect at my first appointment?",
    answer:
      "A first visit is usually an examination with the dentist, and often a cleaning at the same visit if there's time. Allow about 45 minutes. That's what happens at the appointment — anything about your own teeth is for the dentist to say when they see you.",
    category: "visits",
    priority: 80,
  },
  {
    question: "Are you taking new patients?",
    answer: "Yes, we're accepting new patients.",
    category: "visits",
    priority: 70,
  },
  {
    question: "What should I bring to my appointment?",
    answer:
      "Bring your insurance card if you have one, a list of any medications you take, and arrive about ten minutes early if it's your first visit so there's time for the forms.",
    category: "visits",
    priority: 60,
  },
  {
    question: "What is your cancellation policy?",
    answer:
      "We ask for 24 hours' notice if you need to cancel or move an appointment. I can cancel or reschedule for you now if you'd like.",
    category: "policy",
    priority: 60,
  },
  {
    question: "Is there parking? Where are you?",
    answer:
      "There's free parking in the lot in front of the building, and the entrance is on the ground floor.",
    category: "location",
    priority: 50,
  },
  {
    question: "I have a toothache — can I be seen today?",
    answer:
      "We keep time aside for emergency toothache appointments. Let me check what's free today and get you in. If this is severe swelling, trouble breathing or swallowing, or an injury, please go to an emergency room instead.",
    category: "emergency",
    priority: 100,
  },
  {
    question: "How much does a check-up cost? What are your prices?",
    answer:
      "I don't have prices in front of me and I'd rather not guess at what you'd pay. I can take your number and have the front desk go through the costs with you.",
    category: "billing",
    priority: 90,
  },
  {
    question: "Do you see children? Is there a minimum age?",
    answer:
      "Yes, we're a family practice and we see children as well as adults.",
    category: "services",
    priority: 50,
  },
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

function looksLocal(url) {
  return /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(String(url));
}

async function main() {
  const phone = arg("phone");
  if (!phone || phone === true) {
    console.error("Usage: node scripts/seed-knowledge.js --phone +18176011171 [--file rows.json] [--replace] [--confirm]");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. This script writes to Postgres and refuses to guess which one.");
    process.exit(1);
  }
  if (!looksLocal(url) && arg("confirm") !== true) {
    // Same reflex as scripts/db-inspect.js refusing anything that is not
    // staging: the cost of getting this wrong is a real tenant's receptionist
    // answering questions somebody else wrote.
    console.error(
      "DATABASE_URL does not look like a local dev database.\n" +
        "Seeding a real tenant's answers is an operator decision. Re-run with --confirm if you mean it."
    );
    process.exit(1);
  }

  const file = arg("file");
  const rows = file && file !== true ? JSON.parse(readFileSync(file, "utf8")) : BRIGHTWORK;
  if (!Array.isArray(rows) || rows.some((r) => !r?.question || !r?.answer)) {
    console.error("Rows must be a JSON array of objects with question and answer.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const found = await client.query("SELECT id, name FROM businesses WHERE phone_number = $1", [phone]);
    if (found.rowCount === 0) {
      console.error(`No business with phone_number ${phone} in this database.`);
      process.exit(1);
    }
    const { id, name } = found.rows[0];

    if (arg("replace") === true) {
      const gone = await client.query("DELETE FROM business_knowledge WHERE business_id = $1", [id]);
      console.log(`Deleted ${gone.rowCount} existing row(s).`);
    }

    for (const r of rows) {
      await client.query(
        `INSERT INTO business_knowledge (business_id, question, answer, category, priority, enabled)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [id, r.question, r.answer, r.category ?? null, Number.isFinite(r.priority) ? r.priority : 0]
      );
    }

    const total = await client.query(
      "SELECT count(*)::int AS n FROM business_knowledge WHERE business_id = $1 AND enabled",
      [id]
    );
    console.log(`Seeded ${rows.length} row(s) for ${name} (${phone}). Enabled total: ${total.rows[0].n}.`);
    console.log(
      "fetchBusinessKnowledge reads at most 15, ordered by priority DESC — check the count if you add more."
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
