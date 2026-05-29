import type { Migration } from './index.js';

/**
 * LANE H — Skill dispatch end-to-end.
 *
 * Migration 016 created `runs` with a free-form `input` blob, expecting the
 * agency-os dashboard to encode skill identity inside it. That left the
 * agent-runner inside the container with no way to know *which* skill it
 * was supposed to execute — every API trigger arrived as an opaque
 * `[API TRIGGER] Input: {…}` blob, so the agent had nothing to follow.
 * Symptom on the agency-os side: every manual exec from
 * `/admin/skills/<id>/execute` returned `[poll-loop] Result: (empty)`.
 *
 * V1.5 contract (this migration) — first-class skill columns on `runs`:
 *
 *   - skill_slug          : stable identifier (e.g. `brain_recall_test`)
 *   - skill_version       : version number (matches agency-os
 *                           `skill_versions.version`)
 *   - skill_content       : markdown body of the procedure — sent inline by
 *                           the caller, the source of truth for what the
 *                           agent runs. No filesystem sync, no scp, no
 *                           `groups/<folder>/skills/` mount. Stored for
 *                           audit so we can prove what executed even if the
 *                           agency-os version is later edited.
 *   - outcome             : structured final outcome the agent emits at the
 *                           end of its run (free-form text — agents are
 *                           expected to honour the skill markdown's outcome
 *                           shape, the dispatcher does not parse it).
 *
 * Why columns and not a JSONB blob: observability. `SELECT skill_slug,
 * status, ended_at FROM runs WHERE skill_slug = ? ORDER BY ended_at DESC`
 * is the dashboard query, and an index on skill_slug pays for itself the
 * first time someone clicks the skill runs page.
 *
 * Why we don't drop the old `input` column: backward compat. Existing
 * agency-os payloads still carry `input.parameters` (creator_id,
 * queue_item_id, etc.) which the dispatcher's `extractTargetEntityId`
 * already consumes. Adding skill_* fields is purely additive.
 */
export const migration018: Migration = {
  version: 18,
  name: 'skill-dispatch',
  up(db) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN skill_slug TEXT;
      ALTER TABLE runs ADD COLUMN skill_version INTEGER;
      ALTER TABLE runs ADD COLUMN skill_content TEXT;
      ALTER TABLE runs ADD COLUMN outcome TEXT;

      CREATE INDEX idx_runs_skill_slug
        ON runs(skill_slug, ended_at DESC)
        WHERE skill_slug IS NOT NULL;
    `);
  },
};
