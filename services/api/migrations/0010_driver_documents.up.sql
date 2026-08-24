-- 0010 driver documents.
--
-- Owner decision, 2026-08-24, overriding the CLAUDE.md §2 OUT-OF-SCOPE entry
-- for KYC. Recorded in DECISIONS.md.
--
-- ## What this is, and what it deliberately is not
--
-- It records that an administrator SAW a document: its number, who checked it,
-- when, and when it expires. It does not store the document. No image upload,
-- no blob storage, no scanning pipeline. That is a separate surface with its
-- own PII-at-rest, backup and retention problems, and nothing in the
-- requirement asks for it — the fields asked for are all metadata.
--
-- ## Disabled by default
--
-- `required_driver_documents` is seeded EMPTY. With it empty nothing in the
-- system behaves differently: no driver is blocked, and the compliance check
-- does not even run a query. Which documents are legally required in Iraq is
-- not a question this migration answers, and guessing at it would block real
-- drivers from working on the strength of an assumption.
--
-- ## Why EXPIRED is not a status
--
-- Expiry is derived from `expires_at` at the moment of asking, never stored.
-- A stored EXPIRED needs a job to flip rows, and between two runs of that job
-- the column is wrong — which here means a driver with a lapsed licence still
-- taking rides. A derived answer cannot go stale.

CREATE TYPE driver_document_type AS ENUM (
  'NATIONAL_ID',
  'DRIVING_LICENCE',
  'VEHICLE_REGISTRATION',
  'VEHICLE_AUTHORIZATION'
);

-- No EXPIRED member, by the reasoning above.
CREATE TYPE driver_document_status AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

CREATE TABLE driver_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   UUID        NOT NULL REFERENCES drivers(user_id) ON DELETE RESTRICT,
  doc_type    driver_document_type   NOT NULL,
  status      driver_document_status NOT NULL DEFAULT 'PENDING',

  -- The document's own number, as printed on it. Deliberately not the document.
  reference   TEXT        NOT NULL DEFAULT '',

  -- DATE, not TIMESTAMPTZ: documents expire on a day, not at an instant, and a
  -- timestamp would make the boundary depend on the reader's timezone.
  expires_at  DATE        NULL,

  verified_by UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_at TIMESTAMPTZ NULL,

  -- Why it was rejected, shown to the driver.
  note        TEXT        NOT NULL DEFAULT '',

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A verified document with no verifier is an audit trail with a hole in it:
  -- the one question anyone asks later is who approved it.
  CONSTRAINT driver_documents_verified_has_verifier CHECK (
    status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)
  ),

  CONSTRAINT driver_documents_reference_len CHECK (char_length(reference) <= 120),
  CONSTRAINT driver_documents_note_len      CHECK (char_length(note) <= 500)
);

-- One current record per document per driver. History lives in audit_log, which
-- is already append-only — duplicating it here would give two accounts of the
-- same event and no rule for which one is right.
CREATE UNIQUE INDEX driver_documents_driver_type_uq
  ON driver_documents (driver_id, doc_type);

-- Serves the compliance lookup: `WHERE driver_id = ANY($1) AND doc_type = ANY($2)`
-- during matching, which is the only place this is read on a hot path.
-- CLAUDE.md §3.4.
CREATE INDEX driver_documents_lookup_idx
  ON driver_documents (driver_id, doc_type, status);

-- Admin queue: documents waiting to be checked, oldest first.
CREATE INDEX driver_documents_pending_idx
  ON driver_documents (created_at DESC, id DESC)
  WHERE status = 'PENDING';

-- EMPTY. See the header: enabling this is an owner decision informed by legal
-- advice, not a default. A comma-separated list of driver_document_type values.
INSERT INTO platform_config (key, value, description) VALUES
  ('required_driver_documents', '',
   'Comma-separated driver_document_type values a driver must hold, verified and unexpired, to go online. EMPTY disables the check entirely. CLAUDE.md 2 / DECISIONS.md.');
