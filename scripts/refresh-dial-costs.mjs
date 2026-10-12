// Refresh the committed Twilio price snapshot used by lib/dialCost.js.
//
// Usage: node scripts/refresh-dial-costs.mjs [--env <path>] [--from-raw <raw.json>] [--save-raw <raw.json>]
//
// Read-only, free Twilio Pricing API pull (account B credentials from .env).
// Never prints credentials. Prints counts only. Writes BOTH copies of the table
// (lib/ and the dashboard's src/), byte-identical.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTable, assertCompleteTable } from "../lib/dialCost.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TABLE_PATHS = [
  path.join(ROOT, "lib", "dialCostTable.json"),
  path.join(ROOT, "AI-phone-dashboard", "backend", "src", "dialCostTable.json"),
];
export const SOURCE = "Twilio Pricing API v1 (Voice + Messaging Countries), USD";
const NEVER_CATEGORIES = new Set(["premium", "personal", "satellite", "pager", "shared"]);

export function categoryOf(friendlyName) {
  const n = String(friendlyName || "");
  if (/premium/i.test(n)) return "premium";
  if (/personal/i.test(n)) return "personal";
  if (/satellite|inmarsat|iridium|thuraya/i.test(n)) return "satellite";
  if (/pager|paging/i.test(n)) return "pager";
  if (/shared cost/i.test(n)) return "shared";
  if (/special/i.test(n)) return "special";
  if (/mobile/i.test(n)) return "mobile";
  return "fixed";
}

const NAME_PREFIX = "Programmable Outbound Minute - ";

export function transform(raw) {
  // prefix -> [{ price, iso, category, friendly, country }]
  const byPrefix = new Map();
  for (const c of raw.voice || []) {
    if (!c) continue;
    for (const p of c.outbound_prefix_prices || []) {
      const price = Number(p.current_price);
      const category = categoryOf(p.friendly_name);
      for (const prefix of p.prefixes || []) {
        let list = byPrefix.get(prefix);
        if (!list) byPrefix.set(prefix, (list = []));
        list.push({
          price,
          iso: c.iso_country,
          category,
          friendly: String(p.friendly_name || "").replace(NAME_PREFIX, ""),
          country: c.country,
        });
      }
    }
  }

  const voice = {};
  let collisions = 0;
  let collisionsDiffering = 0;
  for (const [prefix, list] of byPrefix) {
    if (list.length === 1) {
      const e = list[0];
      voice[prefix] = [e.price, e.iso, e.category];
      continue;
    }
    collisions += 1;
    const differs = list.some((e) => e.price !== list[0].price || e.category !== list[0].category);
    if (differs) collisionsDiffering += 1;
    // Fail closed: a never-category beats any other, then the highest price, then
    // special (so a tie never loses the stricter rule), then alphabetical ISO.
    const sorted = [...list].sort(
      (a, b) =>
        Number(NEVER_CATEGORIES.has(b.category)) - Number(NEVER_CATEGORIES.has(a.category)) ||
        b.price - a.price ||
        Number(b.category === "special") - Number(a.category === "special") ||
        (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0)
    );
    const win = sorted[0];
    const named = list
      .filter((e) => e.country && win.friendly.startsWith(e.country))
      .sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0))[0];
    const alphaFirst = [...list].map((e) => e.iso).sort()[0];
    voice[prefix] = [win.price, named ? named.iso : alphaFirst, win.category];
  }

  const sms = {};
  for (const c of raw.sms || []) {
    if (!c) continue;
    let mobileMax = null;
    let anyMax = null;
    for (const entry of c.outbound_sms_prices || []) {
      for (const p of entry.prices || []) {
        const v = Number(p.current_price);
        if (!Number.isFinite(v)) continue;
        if (anyMax === null || v > anyMax) anyMax = v;
        if (p.number_type === "mobile" && (mobileMax === null || v > mobileMax)) mobileMax = v;
      }
    }
    const price = mobileMax !== null ? mobileMax : anyMax;
    if (price !== null) sms[c.iso_country] = price;
  }

  const table = { fetched: raw.fetched, source: SOURCE, voice, sms };
  // Non-enumerable stats so tests/main can read them without changing the serialized table.
  Object.defineProperty(table, "stats", { value: { collisions, collisionsDiffering }, enumerable: false });
  return table;
}

export function assertCompletePull(raw) {
  const voice = (raw.voice || []).filter(Boolean);
  if (voice.length < 200) throw new Error(`incomplete pull: only ${voice.length} voice countries`);
  const isos = new Set(voice.map((c) => c.iso_country));
  for (const need of ["GB", "US", "CA"]) {
    if (!isos.has(need)) throw new Error(`incomplete pull: ${need} missing from voice`);
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function serialize(table) {
  const lines = [];
  lines.push("{");
  lines.push(`"fetched":${JSON.stringify(table.fetched)},`);
  lines.push(`"source":${JSON.stringify(table.source)},`);
  const block = (name, obj, last) => {
    const keys = Object.keys(obj).sort(cmp);
    lines.push(`"${name}":{`);
    keys.forEach((k, i) => {
      lines.push(`${JSON.stringify(k)}:${JSON.stringify(obj[k])}${i < keys.length - 1 ? "," : ""}`);
    });
    lines.push(last ? "}" : "},");
  };
  block("voice", table.voice, false);
  block("sms", table.sms, true);
  lines.push("}");
  return lines.join("\n") + "\n";
}

// Pure: would this serialized table boot? Throws if not. Used before ANY write.
export function assertBootable(text) {
  return assertCompleteTable(parseTable(text));
}

function writeAtomic(target, text) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

function parseEnv(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
      })
  );
}

async function fetchRaw(envPath) {
  const env = parseEnv(envPath);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new Error("Twilio credentials missing from the env file");
  const auth = "Basic " + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const get = async (url) => {
    for (let a = 0; a < 3; a++) {
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (r.ok) return r.json();
      if (r.status === 404) return null;
      await new Promise((s) => setTimeout(s, 1000 * (a + 1)));
    }
    throw new Error(`Twilio pricing request failed (${new URL(url).pathname})`);
  };
  const listAll = async (url, key) => {
    const out = [];
    while (url) {
      const j = await get(url);
      out.push(...j[key]);
      url = j.meta?.next_page_url;
    }
    return out;
  };
  const pool = async (items, n, fn) => {
    const res = [];
    let i = 0;
    await Promise.all(
      Array.from({ length: n }, async () => {
        while (i < items.length) {
          const k = i++;
          res[k] = await fn(items[k]);
        }
      })
    );
    return res;
  };
  const voiceList = await listAll("https://pricing.twilio.com/v1/Voice/Countries?PageSize=1000", "countries");
  const smsList = await listAll("https://pricing.twilio.com/v1/Messaging/Countries?PageSize=1000", "countries");
  const voice = await pool(voiceList, 8, (c) => get(`https://pricing.twilio.com/v1/Voice/Countries/${c.iso_country}`));
  const sms = await pool(smsList, 8, (c) => get(`https://pricing.twilio.com/v1/Messaging/Countries/${c.iso_country}`));
  return { fetched: new Date().toISOString(), voice, sms };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const fromRaw = arg("--from-raw");
  const saveRaw = arg("--save-raw");
  const envPath = arg("--env") || path.join(ROOT, ".env");
  const raw = fromRaw ? JSON.parse(fs.readFileSync(fromRaw, "utf8")) : await fetchRaw(envPath);
  if (saveRaw && !fromRaw) fs.writeFileSync(saveRaw, JSON.stringify(raw));
  assertCompletePull(raw);
  const table = transform(raw);
  const text = serialize(table);
  assertBootable(text); // nothing is written unless the result would boot
  for (const p of TABLE_PATHS) writeAtomic(p, text);
  const [a, b] = TABLE_PATHS.map((p) => fs.readFileSync(p));
  if (Buffer.compare(a, b) !== 0 || Buffer.compare(a, Buffer.from(text)) !== 0) {
    throw new Error("the two table copies are not byte-identical after writing");
  }
  const perCat = {};
  for (const v of Object.values(table.voice)) perCat[v[2]] = (perCat[v[2]] || 0) + 1;
  console.log(`voice countries ${raw.voice.filter(Boolean).length}, sms countries ${raw.sms.filter(Boolean).length}`);
  console.log(`prefixes ${Object.keys(table.voice).length}, sms priced countries ${Object.keys(table.sms).length}`);
  console.log(`collisions ${table.stats.collisions}, differing ${table.stats.collisionsDiffering}`);
  console.log(`per category ${JSON.stringify(perCat)}`);
  console.log(`table bytes ${Buffer.byteLength(text)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("refresh failed:", e.message);
    process.exit(1);
  });
}
