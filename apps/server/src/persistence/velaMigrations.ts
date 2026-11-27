import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import VelaCollaborationV2Migration from "./VelaMigrations/001_VelaCollaborationV2.ts";

export type MigrationRow = { readonly id: number; readonly name: string };

const LEGACY_VELA_COLLAB_ID = 117;
const LEGACY_VELA_COLLAB_NAME = "VelaCollaborationV2";
const VELA_COLLAB_MIGRATION_ID = 1;

/**
 * Earlier Vela builds registered `117_VelaCollaborationV2` in upstream's `effect_sql_migrations`.
 * Startup removes that single colliding row before upstream 117+ migrations run, so preflight
 * must treat that exact history as compatible.
 */
export function reconciledVelaCollabHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> {
  const hasLegacyRow = history.some(
    (row) => row.id === LEGACY_VELA_COLLAB_ID && row.name === LEGACY_VELA_COLLAB_NAME,
  );
  if (!hasLegacyRow || !history.every((row) => row.id <= LEGACY_VELA_COLLAB_ID)) {
    return history;
  }
  return history.filter(
    (row) => !(row.id === LEGACY_VELA_COLLAB_ID && row.name === LEGACY_VELA_COLLAB_NAME),
  );
}

/** Checks whether the legacy `117_VelaCollaborationV2` row is present in `effect_sql_migrations`. */
export const hasLegacyVelaCollabMigrationRow = Effect.fn("hasLegacyVelaCollabMigrationRow")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return false;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM effect_sql_migrations
      WHERE migration_id = ${LEGACY_VELA_COLLAB_ID} AND name = ${LEGACY_VELA_COLLAB_NAME}
    `;
    return (rows[0]?.count ?? 0) > 0;
  },
);

/**
 * Removes the colliding `(117, 'VelaCollaborationV2')` row from `effect_sql_migrations` when no
 * later upstream migrations are present, preserving all `vela_collab_*` tables and rows.
 */
export const reconcileLegacyVelaCollabMigration = Effect.fn("reconcileLegacyVelaCollabMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_VELA_COLLAB_ID}
    `;
    if (
      rows.length !== 1 ||
      rows[0]?.migration_id !== LEGACY_VELA_COLLAB_ID ||
      rows[0]?.name !== LEGACY_VELA_COLLAB_NAME
    ) {
      return;
    }
    yield* sql.withTransaction(
      sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id = ${LEGACY_VELA_COLLAB_ID} AND name = ${LEGACY_VELA_COLLAB_NAME}
      `,
    );
  },
);

/**
 * Runs Vela's own schema migrations in `vela_sql_migrations`, independent of upstream's sequential
 * `effect_sql_migrations` numbering. Uses a read-only check first so `PRAGMA query_only = ON`
 * inspection skips write transactions when already current.
 */
export const runVelaMigrations = Effect.fn("runVelaMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vela_sql_migrations'
  `;
  if (tables.length > 0) {
    const applied = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM vela_sql_migrations WHERE migration_id = ${VELA_COLLAB_MIGRATION_ID}
    `;
    if (applied.length > 0) return;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS vela_sql_migrations (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          name TEXT NOT NULL
        )
      `;
      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM vela_sql_migrations WHERE migration_id = ${VELA_COLLAB_MIGRATION_ID}
      `;
      if (applied.length > 0) return;
      yield* VelaCollaborationV2Migration;
      yield* sql`
        INSERT OR IGNORE INTO vela_sql_migrations (migration_id, name)
        VALUES (${VELA_COLLAB_MIGRATION_ID}, ${LEGACY_VELA_COLLAB_NAME})
      `;
    }),
  );
});
