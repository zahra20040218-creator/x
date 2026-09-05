-- 0015 account deletion, as anonymisation.
--
-- ## Why this cannot be a DELETE
--
-- Eighteen foreign keys point at `users(id)` and every one is
-- `ON DELETE RESTRICT`. That is not an oversight to route around - it is what
-- keeps a completed ride, a ride_event and a ledger row from referring to a
-- person who no longer exists. CLAUDE.md 6.3 makes `ledger_entries` append-only
-- with database triggers, so even reaching the row is refused.
--
-- So "delete my account" is implemented as: erase every piece of personal
-- information, sever every credential, and leave the financial and operational
-- record intact but unattributable. Google Play accepts retention of data
-- required for legitimate financial or legal purposes when it is disclosed, and
-- `docs/PLAY_LISTING.md` discloses it.
--
-- What is erased:  phone number, display name, Firebase uid, device tokens,
--                  refresh tokens, and the driver's location history.
-- What survives:   ledger entries, rides, ride_events, payments - the money and
--                  the audit trail, now pointing at an anonymous id.
--
-- ## The tombstone phone number
--
-- `users_phone_e164_format` is `^\+964[0-9]{10}$`, so the column cannot hold a
-- marker like 'DELETED', and `users_phone_role_uq` is UNIQUE on
-- (phone_e164, role), so every deleted account needs a DIFFERENT value.
--
-- Iraqi mobile numbers are +9647XXXXXXXXX - the digit after the country code is
-- always 7. A tombstone therefore uses +9640XXXXXXXXX: it satisfies the CHECK,
-- it can never collide with a real subscriber, and the leading 0 makes it
-- obvious at a glance in a support query that the row is a tombstone rather
-- than a customer.
--
-- The nine digits come from a sequence rather than a hash of the id, because a
-- hash can collide and a collision here fails the unique index at the worst
-- possible moment - mid-deletion, on a user who has already been told the
-- request succeeded.
--
-- ## Why the phone is freed rather than held
--
-- Anonymising rather than reserving means the number becomes available again.
-- That is intended: Iraqi mobile numbers are recycled by the carriers, and a
-- person who deletes their account and later reinstalls must be able to sign up
-- with their own number. They get a NEW account with no history, which is what
-- deletion is supposed to mean.

CREATE SEQUENCE deleted_account_seq;

COMMENT ON SEQUENCE deleted_account_seq IS
  'Supplies the unique digits in a deleted account tombstone phone number.';

ALTER TABLE users
  ADD COLUMN deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN users.deleted_at IS
  'When the user erased their own account. The row survives because rides and '
  'ledger entries reference it; the personal data does not.';

-- Serves the support question "was this account deleted, and when", and keeps
-- deleted rows out of any listing that filters them. Partial, because the
-- overwhelming majority of rows are NULL.
CREATE INDEX users_deleted_at_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;
