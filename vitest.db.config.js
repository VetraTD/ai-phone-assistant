/**
 * The suite that needs a real Postgres.
 *
 * Kept OUT of the root config on purpose. The root suite is 90 files in ~20
 * seconds with no external dependency, and that is a property worth protecting:
 * a test run that needs a container running is a test run people stop doing.
 *
 * Run with:
 *   docker compose -f infra/docker-compose.dev.yml up -d
 *   npm run db:reset
 *   npm run test:db
 *
 * With DATABASE_URL unset these describe blocks skip rather than fail, so the
 * command is safe to wire into CI before the CI has a database.
 *
 * @type {import('vitest').UserConfig}
 */
export default {
  test: {
    environment: "node",
    globals: true,
    include: ["tests/db/**/*.test.js"],
    // One database, shared. Parallel files would interleave their seed and
    // teardown on the same two tenant ids and fail in ways that have nothing to
    // do with isolation.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
