const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'prs.db');
let db = null;

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password  TEXT    NOT NULL,
      created   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS operation_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      username   TEXT    NOT NULL,
      table_id   TEXT    NOT NULL,
      table_name TEXT    DEFAULT '',
      op_type    TEXT    NOT NULL,
      detail     TEXT    DEFAULT '',
      created    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS shared_tables (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      data       TEXT    NOT NULL DEFAULT '[]',
      updated_at TEXT    DEFAULT (datetime('now','localtime')),
      updated_by TEXT    DEFAULT ''
    );
  `);
  // Seed if empty
  try {
    var r = db.exec('SELECT COUNT(*) FROM shared_tables');
    if (r[0].values[0][0] === 0) {
      db.run("INSERT INTO shared_tables (id, data) VALUES (1, '[]')");
    }
  } catch(e) {}

  // Indexes (safe to run multiple times)
  try { db.run('CREATE INDEX idx_logs_table ON operation_logs(table_id)'); } catch(e) {}
  try { db.run('CREATE INDEX idx_logs_user ON operation_logs(user_id)'); } catch(e) {}

  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 10 seconds
setInterval(save, 10000);

// ── Query helpers ──
function findUser(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  stmt.bind([username]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function findUserById(id) {
  const stmt = db.prepare('SELECT id, username, created FROM users WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function createUser(username, hash) {
  db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);
  const lastId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  save();
  return { lastInsertRowid: lastId };
}

function insertLog(userId, username, tableId, tableName, opType, detail) {
  db.run('INSERT INTO operation_logs (user_id, username, table_id, table_name, op_type, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, username, tableId, tableName || '', opType, detail || '']);
  save();
}

function getLogs(tableId, limit, offset) {
  const tid = tableId || '';
  const logs = [];
  let stmt;
  if (tid) {
    stmt = db.prepare('SELECT id, username, table_id, table_name, op_type, detail, created FROM operation_logs WHERE table_id = ? ORDER BY created DESC LIMIT ? OFFSET ?');
    stmt.bind([tid, limit, offset]);
  } else {
    stmt = db.prepare('SELECT id, username, table_id, table_name, op_type, detail, created FROM operation_logs ORDER BY created DESC LIMIT ? OFFSET ?');
    stmt.bind([limit, offset]);
  }
  while (stmt.step()) {
    logs.push(stmt.getAsObject());
  }
  stmt.free();

  let total = 0;
  if (tid) {
    const r = db.exec('SELECT COUNT(*) FROM operation_logs WHERE table_id = ?', [tid]);
    total = r.length ? r[0].values[0][0] : 0;
  } else {
    const r = db.exec('SELECT COUNT(*) FROM operation_logs');
    total = r.length ? r[0].values[0][0] : 0;
  }
  return { logs, total };
}

// ── Shared tables ──
function getTables() {
  const r = db.exec('SELECT data, updated_at, updated_by FROM shared_tables WHERE id = 1');
  if (!r.length || !r[0].values.length) return { tables: [], updatedAt: '', updatedBy: '' };
  const row = r[0].values[0];
  try {
    return { tables: JSON.parse(row[0]), updatedAt: row[1] || '', updatedBy: row[2] || '' };
  } catch(e) {
    return { tables: [], updatedAt: '', updatedBy: '' };
  }
}

function saveTables(tablesJson, username) {
  db.run("UPDATE shared_tables SET data = ?, updated_at = datetime('now','localtime'), updated_by = ? WHERE id = 1",
    [tablesJson, username || '']);
  save();
}

module.exports = { init, findUser, findUserById, createUser, insertLog, getLogs, save, getTables, saveTables };
