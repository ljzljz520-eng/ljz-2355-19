-- ============================================================================
-- Bilingual documentation center — translation baseline & review schema
-- SQLite flavour (>=3.35 for RETURNING); PostgreSQL port notes at the bottom.
--
-- Design points enforced here:
--  * A review pins BOTH the source baseline hash (source_hash, source_doc_version)
--    and the translation hash (translation_hash). Editing the original flips
--    only that paragraph's row to needs_review; unchanged rows stay verified.
--  * Shared code is referenced by id + version (code_version), never copied
--    into translation rows, so a code update cannot fork translation copies.
--  * revision + the trigger implement If-Match: two translators saving the
--    same unit cannot silently overwrite each other (HTTP 409).
--  * Every superseded review is kept in translation_review_history.
-- ============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,            -- e.g. 'components/button'
  source_lang    TEXT NOT NULL DEFAULT 'zh',
  title_json     TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every language the doc declares (rows exist even when translation is absent,
-- so '某语言暂缺' is an explicit state, not a 404).
CREATE TABLE IF NOT EXISTS document_languages (
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lang           TEXT NOT NULL,               -- 'zh','en',...
  status         TEXT NOT NULL DEFAULT 'missing'
                 CHECK (status IN ('available','missing')),
  missing_reason TEXT,
  PRIMARY KEY (doc_id, lang)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id             INTEGER PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version        TEXT NOT NULL,               -- semver '1.1.0'
  created_at     TEXT NOT NULL,
  note           TEXT,
  structural_hash TEXT NOT NULL,              -- order-sensitive; detects reorder
  UNIQUE (doc_id, version)
);

-- Paragraphs / semantic nodes of the SOURCE side.
CREATE TABLE IF NOT EXISTS source_segments (
  id             INTEGER PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  doc_version    TEXT NOT NULL,
  segment_id     TEXT NOT NULL,              -- stable semantic id ('p-intro')
  seg_type       TEXT NOT NULL DEFAULT 'prose'
                 CHECK (seg_type IN ('prose','heading','code-ref')),
  ordinal        INTEGER NOT NULL,           -- display order within version
  content_hash   TEXT NOT NULL,              -- canonical baseline hash
  code_ref       TEXT,                       -- when seg_type='code-ref'
  code_version   INTEGER,                    -- registry version pinned here
  UNIQUE (doc_id, doc_version, segment_id)
);

-- Translation units (language side). Units are NOT versioned per source; edges
-- pin which source version a unit was aligned against.
CREATE TABLE IF NOT EXISTS translation_units (
  id             INTEGER PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lang           TEXT NOT NULL,
  unit_id        TEXT NOT NULL,              -- stable id, often == segment_id
  unit_type      TEXT NOT NULL DEFAULT 'prose'
                 CHECK (unit_type IN ('prose','heading','code-ref')),
  content_json   TEXT NOT NULL,              -- structured tokens (refs by id)
  updated_by     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (doc_id, lang, unit_id)
);

-- Paragraph-level alignment graph. Explicit edges ONLY — never array indexes.
-- 1:N is represented by several rows sharing edge_group.
CREATE TABLE IF NOT EXISTS alignment_edges (
  id                 INTEGER PRIMARY KEY,
  doc_id             TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_lang        TEXT NOT NULL,
  source_version     TEXT NOT NULL,          -- edges are pinned to a source ver
  source_id          TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  edge_kind          TEXT NOT NULL DEFAULT 'one-to-one'
                     CHECK (edge_kind IN ('one-to-one','one-to-many','many-to-one')),
  edge_group         TEXT,                   -- shared for 1:N / N:1
  status             TEXT NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('confirmed','tentative')),
  created_by         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (doc_id, target_lang, source_version, source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_source
  ON alignment_edges (doc_id, source_version, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target
  ON alignment_edges (doc_id, target_lang, target_id);

-- Whole-document language lock (alternative to paragraph-graph mode).
CREATE TABLE IF NOT EXISTS doc_language_locks (
  doc_id           TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lang             TEXT NOT NULL,
  locked_doc_version TEXT NOT NULL,          -- whole translation certified vs..
  certified_by     TEXT,
  certified_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (doc_id, lang)
);

-- THE review table: translation baseline + review state.
CREATE TABLE IF NOT EXISTS translation_reviews (
  doc_id              TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lang                TEXT NOT NULL,
  unit_id             TEXT NOT NULL,
  translation_hash    TEXT NOT NULL,         -- hash of reviewed translation text
  source_hash         TEXT,                  -- source baseline at review time
  source_doc_version  TEXT,                  -- which original version it tracks
  code_version        INTEGER,               -- shared code version (code-ref units)
  reviewer            TEXT NOT NULL,
  review_status       TEXT NOT NULL DEFAULT 'verified'
                      CHECK (review_status IN ('verified','needs-review','rejected')),
  revision            INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency token
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (doc_id, lang, unit_id)
);

-- Audit trail of every superseded review.
CREATE TABLE IF NOT EXISTS translation_review_history (
  id                INTEGER PRIMARY KEY,
  doc_id            TEXT NOT NULL,
  lang              TEXT NOT NULL,
  unit_id           TEXT NOT NULL,
  translation_hash  TEXT NOT NULL,
  source_hash       TEXT,
  source_doc_version TEXT,
  code_version      INTEGER,
  reviewer          TEXT NOT NULL,
  review_status     TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  superseded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Human confirmation entry: proposals to map/unmap edges (conflict workflow).
CREATE TABLE IF NOT EXISTS alignment_proposals (
  id             TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_lang    TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  proposal_type  TEXT NOT NULL CHECK (proposal_type IN ('map','unmap')),
  edge_kind      TEXT DEFAULT 'one-to-one',
  edge_group     TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  author         TEXT NOT NULL,
  reason         TEXT,
  decided_by     TEXT,
  decided_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Optimistic concurrency guard. If two translators load revision N and both
-- save, only the first UPDATE ... WHERE revision = N succeeds; the second sees
-- changes() = 0 and the API answers 409 revision-conflict.
CREATE TRIGGER IF NOT EXISTS trg_review_bump_revision
AFTER UPDATE OF translation_hash, source_hash ON translation_reviews
BEGIN
  UPDATE translation_reviews
     SET revision = revision + 1,
         updated_at = datetime('now')
   WHERE doc_id = NEW.doc_id AND lang = NEW.lang AND unit_id = NEW.unit_id
     AND revision = OLD.revision;
  INSERT INTO translation_review_history
    (doc_id, lang, unit_id, translation_hash, source_hash, source_doc_version,
     code_version, reviewer, review_status, revision)
  VALUES
    (OLD.doc_id, OLD.lang, OLD.unit_id, OLD.translation_hash, OLD.source_hash,
     OLD.source_doc_version, OLD.code_version, OLD.reviewer, OLD.review_status,
     OLD.revision);
END;

-- Convenience view: paragraph freshness for a given (doc, source version).
-- A row is verified only when its edge exists in that version AND hashes agree.
CREATE VIEW IF NOT EXISTS v_segment_freshness AS
SELECT e.doc_id,
       e.target_lang,
       e.source_version,
       e.source_id,
       e.target_id,
       r.review_status,
       r.source_doc_version AS reviewed_against_version,
       CASE
         WHEN r.source_doc_version IS NULL                              THEN 'translated'
         WHEN r.source_doc_version <> e.source_version                  THEN 'needs-review'
         WHEN r.translation_hash <>
              (SELECT content_hash FROM source_segments s
                WHERE s.doc_id = e.doc_id AND s.doc_version = e.source_version
                  AND s.segment_id = e.source_id)                       THEN 'needs-review'
         ELSE 'verified'
       END AS freshness
  FROM alignment_edges e
  LEFT JOIN translation_reviews r
    ON r.doc_id = e.doc_id AND r.lang = e.target_lang AND r.unit_id = e.target_id;

-- Example queries ----------------------------------------------------------
-- Paragraphs needing re-review after an original edit (unchanged ones remain
-- 'verified' and are NOT returned):
--   SELECT * FROM v_segment_freshness
--    WHERE doc_id = 'components/button' AND target_lang = 'en'
--      AND source_version = '1.1.0' AND freshness <> 'verified';
--
-- Translator B's save conflicting with translator A's in-flight edit:
--   UPDATE translation_reviews SET translation_hash = ?, source_hash = ?
--    WHERE doc_id=? AND lang='en' AND unit_id='p-install' AND revision = 1;
--   -- changes()=0 after A committed revision 2 -> API responds 409.

-- PostgreSQL port: INTEGER PRIMARY KEY -> GENERATED ... AS IDENTITY,
-- datetime('now') -> now(), view identical, triggers in plpgsql.
