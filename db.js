const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// 支持通过环境变量指定数据目录（Railway Volume 挂载路径）
// Railway 控制台设置：DATA_DIR=/app/data（或 Volume 挂载点）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'prs.db');
let db = null;

async function init() {
  // 启动时打印关键路径，方便排查持久化问题
  console.log('[DB] 数据目录:', DATA_DIR);
  console.log('[DB] 数据库文件:', DB_PATH);
  console.log('[DB] 文件已存在:', fs.existsSync(DB_PATH));
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.log('[DB] Railway Volume 挂载路径:', process.env.RAILWAY_VOLUME_MOUNT_PATH);
  } else if (process.env.FLY_APP_NAME) {
    console.log('[DB] Fly.io 应用:', process.env.FLY_APP_NAME);
  } else {
    console.warn('[DB] 警告: 未检测到 Volume，数据将存储在临时文件系统，重启后会丢失！');
  }

  // 检测一次性恢复用的 staged 文件，存在则替换 prs.db
  const stagedPath = path.join(DATA_DIR, 'prs-staged.db');
  if (fs.existsSync(stagedPath)) {
    console.log('[DB] 检测到 staged 恢复文件，准备替换 prs.db');
    try {
      fs.renameSync(stagedPath, DB_PATH);
      console.log('[DB] 已将 staged 文件替换为 prs.db');
    } catch (e) {
      console.error('[DB] staged 替换失败:', e.message);
    }
  }

  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log('[DB] 已从磁盘加载数据库');
  } else {
    db = new SQL.Database();
    console.log('[DB] 创建新数据库（首次启动或 Volume 未挂载）');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password  TEXT    NOT NULL,
      created   TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
    );
    CREATE TABLE IF NOT EXISTS operation_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      username   TEXT    NOT NULL,
      table_id   TEXT    NOT NULL,
      table_name TEXT    DEFAULT '',
      op_type    TEXT    NOT NULL,
      detail     TEXT    DEFAULT '',
      created    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS shared_tables (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      data       TEXT    NOT NULL DEFAULT '[]',
      updated_at TEXT    DEFAULT (datetime('now','+8 hours')),
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
  fs.writeFileSync(DB_PATH, Buffer.from(data)); // 不捕获异常，让调用方感知失败
}

// Auto-save every 10 seconds（捕获异常防止进程崩溃，但 save() 本身不吞异常）
setInterval(() => {
  try {
    save();
  } catch (e) {
    console.error('[DB] 定时保存失败:', e.message, '| 路径:', DB_PATH);
    if (e.code === 'EROFS') console.error('[DB] 文件系统只读！请检查 Railway Volume 配置');
    if (e.code === 'ENOSPC') console.error('[DB] 磁盘空间不足！请检查 Railway Volume 容量');
  }
}, 10000);

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
  db.run("UPDATE shared_tables SET data = ?, updated_at = datetime('now','+8 hours'), updated_by = ? WHERE id = 1",
    [tablesJson, username || '']);
  save();
}

// 清理超过 7 天的操作日志
// 返回删除的条数
function cleanupOldLogs() {
  // 先查出要删除的数量
  const r = db.exec("SELECT COUNT(*) FROM operation_logs WHERE created < datetime('now','+8 hours','-7 days')");
  const count = r.length ? r[0].values[0][0] : 0;
  if (count > 0) {
    db.run("DELETE FROM operation_logs WHERE created < datetime('now','+8 hours','-7 days')");
    save();
  }
  return count;
}

module.exports = { init, findUser, findUserById, createUser, insertLog, getLogs, save, getTables, saveTables, cleanupOldLogs };
