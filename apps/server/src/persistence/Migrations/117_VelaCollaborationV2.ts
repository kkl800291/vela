import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE vela_collab_plans (
      plan_id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      target_worktree TEXT NOT NULL,
      git_common_dir TEXT,
      plan_version INTEGER NOT NULL CHECK (plan_version > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN (
        'draft', 'running', 'batch_verifying', 'ready_to_deliver', 'delivered', 'cancelled', 'failed'
      )),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX vela_collab_active_plan ON vela_collab_plans(environment_id, parent_thread_id)
    WHERE status IN ('draft', 'running', 'batch_verifying', 'ready_to_deliver')
  `;

  yield* sql`
    CREATE TABLE vela_collab_steps (
      plan_id TEXT NOT NULL REFERENCES vela_collab_plans(plan_id),
      step_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'locked', 'ready', 'developing', 'verifying_gates', 'queued_for_review', 'reviewing',
        'integrating', 'integrated', 'done', 'needs_attention', 'cancelled'
      )),
      review_id TEXT,
      review_sequence INTEGER,
      integration_sequence INTEGER,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (plan_id, step_id)
    )
  `;
  yield* sql`
    CREATE INDEX vela_collab_review_queue ON vela_collab_steps(plan_id, review_sequence)
    WHERE status = 'queued_for_review'
  `;
  yield* sql`
    CREATE INDEX vela_collab_integration_queue ON vela_collab_steps(plan_id, integration_sequence)
    WHERE status = 'integrating'
  `;

  yield* sql`
    CREATE TABLE vela_collab_inbox (
      inbox_item_id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES vela_collab_plans(plan_id),
      kind TEXT NOT NULL CHECK (kind IN (
        'review', 'orchestrator_escalation', 'batch_verification_failed', 'delivery_ready'
      )),
      step_id TEXT,
      review_id TEXT,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      thread_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'completed', 'invalidated')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      receipt_json TEXT CHECK (json_valid(receipt_json))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX vela_collab_active_inbox ON vela_collab_inbox(environment_id, parent_thread_id)
    WHERE status IN ('pending', 'dispatched')
  `;
  yield* sql`
    CREATE UNIQUE INDEX vela_collab_inbox_run ON vela_collab_inbox(environment_id, parent_thread_id, thread_run_id)
    WHERE thread_run_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE vela_collab_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      plan_id TEXT NOT NULL REFERENCES vela_collab_plans(plan_id),
      kind TEXT NOT NULL CHECK (kind IN (
        'enqueue_inbox', 'create_worktree', 'remove_worktree', 'send_thread',
        'initialize_plan', 'freeze_step_base', 'verify_step_gates', 'verify_batch_gates', 'freeze_delivery',
        'update_integration', 'apply_delivery', 'revert_delivery'
      )),
      expected_plan_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'invalidated')),
      receipt_json TEXT CHECK (json_valid(receipt_json)),
      recovery_json TEXT CHECK (json_valid(recovery_json))
    )
  `;
  yield* sql`
    CREATE INDEX vela_collab_pending_outbox ON vela_collab_outbox(plan_id, sequence) WHERE status = 'pending'
  `;

  yield* sql`
    CREATE UNIQUE INDEX vela_collab_wake_command ON vela_collab_outbox(json_extract(payload_json, '$.commandId'))
    WHERE kind = 'enqueue_inbox'
  `;
  yield* sql`
    CREATE UNIQUE INDEX vela_collab_wake_message ON vela_collab_outbox(json_extract(payload_json, '$.messageId'))
    WHERE kind = 'enqueue_inbox'
  `;

  yield* sql`
    CREATE TABLE vela_collab_leases (
      kind TEXT NOT NULL CHECK (kind IN ('integration', 'target_worktree')),
      resource_id TEXT NOT NULL,
      operation_id TEXT NOT NULL REFERENCES vela_collab_outbox(operation_id),
      owner_id TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (kind, resource_id)
    )
  `;

  yield* sql`
    CREATE TABLE vela_collab_receipts (
      command_id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL REFERENCES vela_collab_plans(plan_id),
      request_key TEXT NOT NULL,
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json))
    )
  `;

  yield* sql`
    CREATE TABLE vela_collab_records (
      plan_id TEXT NOT NULL REFERENCES vela_collab_plans(plan_id),
      kind TEXT NOT NULL CHECK (kind IN ('review', 'verdict', 'batch_audit', 'delivery', 'applied', 'reverted')),
      record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (plan_id, kind, record_id)
    )
  `;
});
