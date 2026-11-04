// Schema migrations, applied in order by persistence/db.ts. Embedded as strings so
// the compiled output is self-contained. Never edit an applied migration; add a new one.

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INIT = /* sql */ `
CREATE TABLE cases (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'LB-[0-9][0-9][0-9]*'),
  state            TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0,          -- optimistic lock
  reporter_id      TEXT NOT NULL,
  room_id          TEXT NOT NULL,
  thread_id        TEXT,
  repo             TEXT NOT NULL,                       -- owner/repo
  report_text      TEXT NOT NULL,                       -- untrusted, never logged in full
  branch           TEXT,
  pr_number        INTEGER,
  head_sha         TEXT CHECK (head_sha IS NULL OR length(head_sha) = 40),
  blocked_reason   TEXT,                                -- reason code while Blocked
  state_entered_at TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE case_commits (
  case_id     TEXT NOT NULL REFERENCES cases(id),
  head_sha    TEXT NOT NULL CHECK (length(head_sha) = 40),
  base_sha    TEXT NOT NULL CHECK (length(base_sha) = 40),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (case_id, head_sha)
);

CREATE TABLE verification_runs (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,       -- monotonic: latest run wins (M-b)
  id           TEXT NOT NULL UNIQUE,
  case_id      TEXT NOT NULL REFERENCES cases(id),
  repo         TEXT NOT NULL,
  pr_number    INTEGER NOT NULL,
  head_sha     TEXT NOT NULL CHECK (length(head_sha) = 40),
  status       TEXT NOT NULL CHECK (status IN ('requested','pass','fail','invalid','timeout')),
  report_json  TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX verification_runs_case_head ON verification_runs(case_id, head_sha);

CREATE TABLE ci_evidence (
  id           TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL REFERENCES cases(id),
  head_sha     TEXT NOT NULL CHECK (length(head_sha) = 40),
  check_name   TEXT NOT NULL,
  check_run_id INTEGER NOT NULL,
  app_slug     TEXT NOT NULL,
  status       TEXT NOT NULL,
  conclusion   TEXT,
  html_url     TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  UNIQUE (case_id, head_sha, check_name, check_run_id)
);

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id),
  repo            TEXT NOT NULL,                        -- D11
  pr_number       INTEGER NOT NULL,                     -- D11
  approver_id     TEXT NOT NULL,
  head_sha        TEXT NOT NULL CHECK (length(head_sha) = 40),
  decision        TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  source_event_id TEXT NOT NULL UNIQUE,
  reason          TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (case_id, head_sha, approver_id)
);
CREATE INDEX approvals_case_head ON approvals(case_id, head_sha);
-- D11: an approval must name the case's repository and current PR.
CREATE TRIGGER approvals_bind_case BEFORE INSERT ON approvals
WHEN NOT EXISTS (
  SELECT 1 FROM cases c WHERE c.id = NEW.case_id AND c.repo = NEW.repo AND c.pr_number = NEW.pr_number
)
BEGIN SELECT RAISE(ABORT, 'approval does not match the case repository and PR'); END;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;

CREATE TABLE merge_operations (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES cases(id),
  head_sha         TEXT NOT NULL CHECK (length(head_sha) = 40),
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),          -- D15
  idempotency_key  TEXT NOT NULL UNIQUE,                           -- case:sha:attempt
  status           TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','unknown')),
  github_merge_sha TEXT,
  error            TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  UNIQUE (case_id, head_sha, attempt),
  CHECK (idempotency_key = case_id || ':' || head_sha || ':' || attempt)
);

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      TEXT,
  actor_id     TEXT NOT NULL,                      -- participant id or 'system'
  event_type   TEXT NOT NULL,
  target_sha   TEXT,
  reason_code  TEXT,                               -- machine-readable
  payload_json TEXT NOT NULL,                      -- redacted
  created_at   TEXT NOT NULL
);
CREATE INDEX audit_events_case ON audit_events(case_id, id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TABLE processed_events (
  event_id     TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- connection_id, cursor, next case number, expected base
`;

// One decision of each kind per maintainer per SHA: an approval followed by a rejection of the
// same commit keeps both rows (the rejection blocks the merge); repeats of the same decision dedupe.
const APPROVAL_DECISIONS = /* sql */ `
CREATE TABLE approvals_v2 (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id),
  repo            TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  approver_id     TEXT NOT NULL,
  head_sha        TEXT NOT NULL CHECK (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
  decision        TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  source_event_id TEXT NOT NULL UNIQUE,
  reason          TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (case_id, head_sha, approver_id, decision)
);
INSERT INTO approvals_v2 (id, case_id, repo, pr_number, approver_id, head_sha, decision, source_event_id, reason, created_at)
  SELECT id, case_id, repo, pr_number, approver_id, head_sha, decision, source_event_id, reason, created_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_v2 RENAME TO approvals;
CREATE INDEX approvals_case_head ON approvals(case_id, head_sha);
CREATE TRIGGER approvals_bind_case BEFORE INSERT ON approvals
WHEN NOT EXISTS (
  SELECT 1 FROM cases c WHERE c.id = NEW.case_id AND c.repo = NEW.repo AND c.pr_number = NEW.pr_number
)
BEGIN SELECT RAISE(ABORT, 'approval does not match the case repository and PR'); END;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
`;

// D28: a run can be explicitly superseded by a newer request for the same case, so it can
// never complete later. SQLite cannot alter a CHECK constraint, so the table is rebuilt; rows,
// sequence numbers (latest-run order) and the index are preserved. Nothing references this table.
const SUPERSEDED_RUNS = /* sql */ `
CREATE TABLE verification_runs_v3 (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  case_id      TEXT NOT NULL REFERENCES cases(id),
  repo         TEXT NOT NULL,
  pr_number    INTEGER NOT NULL,
  head_sha     TEXT NOT NULL CHECK (length(head_sha) = 40),
  status       TEXT NOT NULL CHECK (status IN ('requested','pass','fail','invalid','timeout','superseded')),
  report_json  TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);
INSERT INTO verification_runs_v3 (seq, id, case_id, repo, pr_number, head_sha, status, report_json, requested_at, completed_at)
  SELECT seq, id, case_id, repo, pr_number, head_sha, status, report_json, requested_at, completed_at FROM verification_runs;
DROP TABLE verification_runs;
ALTER TABLE verification_runs_v3 RENAME TO verification_runs;
CREATE INDEX verification_runs_case_head ON verification_runs(case_id, head_sha);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", sql: INIT },
  { version: 2, name: "approval_decisions", sql: APPROVAL_DECISIONS },
  { version: 3, name: "superseded_runs", sql: SUPERSEDED_RUNS },
];
