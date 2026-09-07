# Archive — historical, NOT authoritative

Thirteen status and audit documents written between 2026-08-22 and 2026-09-05.
They are kept because several contain reasoning that is still worth reading,
and deleting them would destroy the record of how decisions were reached.

**Do not plan from anything in this directory.** Every file here has been
checked against the code and at least one load-bearing claim in each is now
false. Three examples, each verified on 2026-09-07:

- `LAUNCH_BLOCKERS.md` M-1 — "Neither mobile app can be built. The rider app
  has no Android project." `apps/aly/android/` is a complete Android project
  today; the app builds, installs and runs.
- `STATUS.txt` — "611 tests passing". The count is 1,138 (759 backend, 339
  Flutter core, 40 app).
- `FINAL_REPORT.md` — "has never once been executed against a real PostgreSQL".
  Commit 57d70fa records the integration suite running against real Postgres
  and Redis.

For the current state, read `STATUS.md` at the repository root. For decisions,
`DECISIONS.md`. For defects, `DEFECTS.md`. For the architecture,
`docs/ARCHITECTURE.md`. Those four are maintained; these are not.
