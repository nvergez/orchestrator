# Issue #93 plan: multi-channel and multi-user Slack support

## Scope and decisions

Ship multi-channel and multi-user support together. The two configuration changes are small on their own, but multi-channel changes the identity of every session, mailbox, relay, and dashboard row; shipping only the authorization half would leave a short-lived configuration contract that the channel half immediately replaces. One release with one migration gives operators a single upgrade step and lets the tests exercise the real end state.

The durable identity of a Slack thread will be `(channel_id, thread_ts)`. Slack timestamps are unique only within a conversation, so every in-memory key, public thread-scoped interface, SQL predicate, watcher loop, relay lookup, and Slack write must carry both values. Runtime-issued `dispatch_id` and bus `msg_id` remain globally unique primary keys, but records that are selected or grouped as part of a thread are channel-scoped. `mailboxes` and `reconciliations` move to composite primary keys; `pending_gates` and `stall_alerts` gain `channel_id`; and delegation event fallbacks use both channel and timestamp.

Configuration will use comma-separated plural variables:

- `SLACK_CHANNEL_IDS=C...,C...`
- `SLACK_ALLOWED_USER_IDS=U...,U...`

Values are trimmed, de-duplicated in declaration order, and every item is prefix-validated. Empty items and an empty list are invalid. For a non-breaking operator migration, each plural key falls back to its existing singular counterpart (`SLACK_CHANNEL_ID` / `SLACK_ALLOWED_USER_ID`) when the plural key is absent; setting both is invalid so there is one source of truth. Generated templates and setup/spec documentation use only the plural names.

Authorization is a shared-operations model: any allow-listed user may open a session, reply in any registered thread, answer a decision gate or escalation, and close the session, regardless of `root_user`. This matches the existing channel-centric product and avoids a misleading ownership boundary around operational work. `root_user` remains the opener/attribution field and will be shown with `channel_id` on the dashboard. A root mention from an unauthorized user gets a generic authorized-operators refusal; unauthorized thread replies remain silent.

`SESSION_LIVE_CAP` and `WORKER_CAP` remain daemon-global safety/cost controls. Per-user quotas would make work availability depend on identity and would require scheduling and policy concepts beyond an allow-list. Cost stays per session as today; showing the opener on the dashboard supplies attribution without changing billing semantics.

Multi-workspace support, per-channel routing hints, permission tiers, per-user quotas, channel-name lookup, and mutable dashboard behavior remain out of scope.

## Public seams and test strategy

Use vertical test-first slices at these public seams:

1. `loadConfig`: parses plural lists, validates each ID, rejects ambiguous plural+singular configuration, and accepts legacy singular keys.
2. `classifyEvent` / registered Slack handlers: accepts every configured channel and user, carries the event channel into session/gate operations and Slack replies, and preserves unauthorized-user behavior.
3. `SessionManager`, gate keeper, delegation coordinator/store, relay, watcher, watchdog, reconciliation, and thread surface: two channels may use the same `thread_ts` without sharing queues, gates, mailboxes, cards, reactions, reconciliation fingerprints, or bus-event fallback resolution.
4. `DelegationStore` migration: a database created by the single-channel schema is upgraded in place with rows preserved, WAL still enabled, composite thread keys enforced, and thread collisions permitted after migration.
5. `/api/state` and React presentation: rows are grouped by composite thread identity and session cards/history visibly include channel and opener; an older or partially-created database remains readable.
6. CLI/config documentation: `orc init`, doctor coverage, `.env.example`, Slack setup, `CONTEXT.md`, and `docs/spec.md` agree on the plural contract and shared-operator semantics.

Focused tests will run after each slice. The final review will inspect the complete diff for unscoped `thread_ts` queries and pinned-channel Slack calls, then run `npm test`, `npm run typecheck`, `npm run typecheck:web`, `npm run lint`, and `npm run prepack`.

## Implementation order

1. Introduce the plural configuration and filter/handler behavior.
2. Carry channel identity through session callbacks, Slack surfaces, permission/gate interfaces, and delegation coordination.
3. Upgrade the delegation schema and re-key all thread-scoped queries and runtime maps.
4. Update dashboard grouping and attribution, then update operator-facing templates and documentation.
5. Self-review, fix findings, run every CI gate, push, and open a Conventional Commits PR against `main`.
