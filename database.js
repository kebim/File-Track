'use strict';
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'filetrack.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------- schema version — bump to migrate ---------- */
const SCHEMA_VERSION = 4;

const currentVersion = db.pragma('user_version', { simple: true });

/* ---------------------------------------------------------------
   FRESH INSTALL (version 0 → 4): create everything from scratch
   --------------------------------------------------------------- */
if (currentVersion === 0) {
  db.exec(`
    CREATE TABLE departments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      rank          INTEGER NOT NULL,
      department_id INTEGER,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      UNIQUE(department_id, rank),
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
    );
    CREATE TABLE users (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      username             TEXT UNIQUE NOT NULL,
      password_hash        TEXT NOT NULL,
      full_name            TEXT NOT NULL,
      position_id          INTEGER NOT NULL,
      department_id        INTEGER,
      is_super_admin       INTEGER NOT NULL DEFAULT 0,
      active               INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL,
      FOREIGN KEY (position_id) REFERENCES positions(id),
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
    );
    CREATE TABLE sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE files (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_no             TEXT UNIQUE NOT NULL,
      subject            TEXT NOT NULL,
      description        TEXT,
      priority           TEXT NOT NULL DEFAULT 'Normal',
      status             TEXT NOT NULL DEFAULT 'Open',
      department_id      INTEGER,
      creator_id         INTEGER NOT NULL,
      current_holder_id  INTEGER NOT NULL,
      due_date           TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      FOREIGN KEY (creator_id) REFERENCES users(id),
      FOREIGN KEY (current_holder_id) REFERENCES users(id)
    );
    CREATE TABLE file_participants (
      file_id  INTEGER NOT NULL,
      user_id  INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (file_id, user_id),
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE movements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id      INTEGER NOT NULL,
      action       TEXT NOT NULL,
      from_user_id INTEGER,
      to_user_id   INTEGER NOT NULL,
      remarks      TEXT,
      created_at   TEXT NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );
    CREATE TABLE counters (
      year  INTEGER PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      action     TEXT NOT NULL,
      details    TEXT,
      ip         TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL,
      orig_name   TEXT    NOT NULL,
      stored_name TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL,
      size_bytes  INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      FOREIGN KEY (file_id)     REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );
    CREATE INDEX idx_files_holder   ON files(current_holder_id);
    CREATE INDEX idx_files_creator  ON files(creator_id);
    CREATE INDEX idx_files_status   ON files(status);
    CREATE INDEX idx_movements_file ON movements(file_id);
    CREATE INDEX idx_part_user      ON file_participants(user_id);
    CREATE INDEX idx_sessions_user  ON sessions(user_id);
    CREATE INDEX idx_positions_dept ON positions(department_id, rank);
    CREATE INDEX idx_users_dept     ON users(department_id);
    CREATE INDEX idx_attach_file    ON attachments(file_id);
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  console.log('[FileTrack] Fresh database created (schema v4).');
}

/* ---------------------------------------------------------------
   MIGRATION: v3 → v4 — ADD ATTACHMENTS ONLY, keep all data
   --------------------------------------------------------------- */
else if (currentVersion === 3) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL,
      orig_name   TEXT    NOT NULL,
      stored_name TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL,
      size_bytes  INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      FOREIGN KEY (file_id)     REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_attach_file ON attachments(file_id);
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  console.log('[FileTrack] Migrated schema v3 → v4 (attachments added).');
}

/* ---------------------------------------------------------------
   SAFETY: any future schema change → migrate additively here.
   If schema is somehow newer than the code, warn but don't wipe.
   --------------------------------------------------------------- */
else if (currentVersion > SCHEMA_VERSION) {
  console.warn(`[FileTrack] DB schema is v${currentVersion} but code expects v${SCHEMA_VERSION}.`);
}

/* ---------- seed default data ---------- */
if (db.prepare('SELECT COUNT(*) AS c FROM departments').get().c === 0) {
  const bcrypt = require('bcryptjs');
  const now = new Date().toISOString();
  const insDept = db.prepare('INSERT INTO departments (code,name,active,created_at) VALUES (?,?,1,?)');
  const insPos  = db.prepare('INSERT INTO positions (name,rank,department_id,active,created_at) VALUES (?,?,?,1,?)');

  const template = [
    { name:'Director',      rank:1 },
    { name:'Dy Director',   rank:2 },
    { name:'Manager',       rank:3 },
    { name:'Sr. Officer',   rank:4 },
    { name:'Officer',       rank:5 },
    { name:'Sr. Assistant', rank:6 }
  ];

  const addDept = (code, name) => {
    const id = insDept.run(code, name, now).lastInsertRowid;
    template.forEach(p => insPos.run(p.name, p.rank, id, now));
    return id;
  };

  addDept('GSPMD', 'General Services & Project Management Division');
  addDept('HRD',   'Human Resource Department');
  addDept('FD',    'Finance Department');
  addDept('CSD',   'Customer Service Department');

  const heId = insPos.run('High Executive', 1, null, now).lastInsertRowid;
  db.prepare(`INSERT INTO users
    (username,password_hash,full_name,position_id,department_id,is_super_admin,active,created_at)
    VALUES (?,?,?,?,NULL,1,1,?)`)
    .run('admin', bcrypt.hashSync('Admin@123', 10), 'System Administrator', heId, now);

  console.log('[FileTrack] Seeded departments, positions and default admin (admin / Admin@123)');
}

module.exports = db;