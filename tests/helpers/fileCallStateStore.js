import fs from "fs";
import path from "path";

/**
 * A call-state store backed by a file, so two OS processes can share it.
 *
 * This exists to answer one question honestly: is the shared slice big enough?
 * The in-memory store cannot answer it — by construction a second process sees
 * nothing — and Memorystore is B2. A file is the smallest thing that is
 * genuinely cross-process, and being genuinely cross-process is the entire
 * point of the test that uses it.
 *
 * It is NOT a production adapter and should never become one: read-modify-write
 * on a file has no locking, so two concurrent merges can lose one. That is
 * tolerable for a test with one writer and one reader, and disqualifying for
 * anything else.
 *
 * @param {string} file
 * @returns {import("../../lib/callStateStore.js").CallStateStore}
 */
export function createFileStore(file) {
  function readAll() {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  }

  function writeAll(all) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all), "utf8");
  }

  return {
    async get(callSid) {
      return readAll()[callSid] ?? null;
    },
    async merge(callSid, patch) {
      const all = readAll();
      all[callSid] = { ...(all[callSid] ?? {}), ...patch };
      writeAll(all);
    },
    async delete(callSid) {
      const all = readAll();
      delete all[callSid];
      writeAll(all);
    },
  };
}
