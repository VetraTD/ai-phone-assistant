import { createFileStore } from "./fileCallStateStore.js";
import { createPgStore } from "../../lib/callStateStore.js";

/**
 * Build the store a child process should use, from a kind and a target string.
 *
 * The two child processes (callStateWriter/callStateReader) are the honest part
 * of the cross-process test: state that looks shared while it is really the
 * same Map is exactly what a single-process test cannot see. This exists so the
 * SAME two processes can be pointed at either backend without the test having
 * two copies of its assertions.
 *
 * For `pg` the pool is created HERE, inside the child. That is deliberate and
 * is the property the Postgres half is claiming: two independent pools, in two
 * independent processes, one writing and one reading.
 *
 * @param {"file"|"pg"} kind
 * @param {string} target file path, or a Postgres connection string
 * @returns {Promise<{ store: import("../../lib/callStateStore.js").CallStateStore, close: () => Promise<void> }>}
 */
export async function storeForKind(kind, target) {
  if (kind === "file") {
    return { store: createFileStore(target), close: async () => {} };
  }

  if (kind === "pg") {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: target, max: 2 });
    // No prune timer: a child process that lives for 50ms has nothing to sweep,
    // and an interval is one more thing that could hold it open.
    const store = createPgStore({ pool, pruneIntervalMs: 0 });
    return {
      store,
      close: async () => {
        store.close();
        await pool.end();
      },
    };
  }

  throw new Error(`unknown store kind: ${kind}`);
}
