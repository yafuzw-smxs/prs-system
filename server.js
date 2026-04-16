const express = require('express');
const path = require('path');
const db = require('./db');
const { hashPassword, comparePassword, signToken, authMiddleware } = require('./auth');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── Static: serve the HTML app ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname));

// ── API: Register ──
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (username.trim().length < 2 || username.trim().length > 20) return res.status(400).json({ error: '用户名需2-20个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });

  const existing = db.findUser(username.trim());
  if (existing) return res.status(409).json({ error: '用户名已存在' });

  const hash = hashPassword(password);
  const result = db.createUser(username.trim(), hash);
  const token = signToken({ userId: result.lastInsertRowid, username: username.trim() });

  res.json({ ok: true, token, user: { id: result.lastInsertRowid, username: username.trim() } });
});

// ── API: Login ──
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  const user = db.findUser(username.trim());
  if (!user || !comparePassword(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = signToken({ userId: user.id, username: user.username });
  res.json({ ok: true, token, user: { id: user.id, username: user.username } });
});

// ── API: Validate token ──
app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.findUserById(req.user.userId);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  res.json({ user: { id: user.id, username: user.username } });
});

// ── API: Log operation ──
app.post('/api/log', authMiddleware, (req, res) => {
  const { tableId, tableName, opType, detail } = req.body || {};
  if (!tableId || !opType) return res.status(400).json({ error: '缺少参数' });
  db.insertLog(req.user.userId, req.user.username, String(tableId), tableName || '', opType, detail || '');
  res.json({ ok: true });
});

// ── API: Get logs ──
app.get('/api/logs', authMiddleware, (req, res) => {
  const tableId = req.query.tableId || '';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const result = db.getLogs(tableId, limit, offset);
  res.json(result);
});

// ── API: Get shared tables ──
app.get('/api/tables', authMiddleware, (req, res) => {
  const result = db.getTables();
  res.json(result);
});

// ── API: Save shared tables ──
app.put('/api/tables', authMiddleware, (req, res) => {
  const { tables } = req.body || {};
  if (!Array.isArray(tables)) return res.status(400).json({ error: '无效数据' });
  db.saveTables(JSON.stringify(tables), req.user.username);
  res.json({ ok: true });
});

// ── Auto Backup: daily backup, keep 7 days ──
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
function runBackup() {
  try {
    if (!require('fs').existsSync(BACKUP_DIR)) require('fs').mkdirSync(BACKUP_DIR, { recursive: true });
    const dbPath = path.join(__dirname, 'data', 'prs.db');
    if (!require('fs').existsSync(dbPath)) return;
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const backupPath = path.join(BACKUP_DIR, `prs-backup-${date}.db`);
    require('fs').copyFileSync(dbPath, backupPath);
    console.log(`[备份] 已创建 ${backupPath}`);
    // Clean backups older than 7 days
    const files = require('fs').readdirSync(BACKUP_DIR).filter(f => f.startsWith('prs-backup-') && f.endsWith('.db'));
    files.sort();
    while (files.length > 7) {
      const old = files.shift();
      require('fs').unlinkSync(path.join(BACKUP_DIR, old));
      console.log(`[备份] 已删除旧备份 ${old}`);
    }
  } catch (e) { console.error('[备份] 失败:', e.message); }
}
// Run backup on startup and every 24 hours
setTimeout(runBackup, 5000);
setInterval(runBackup, 24 * 60 * 60 * 1000);

// ── API: Manual backup download ──
app.get('/api/backup', authMiddleware, (req, res) => {
  db.save(); // flush to disk first
  const dbPath = path.join(__dirname, 'data', 'prs.db');
  if (!require('fs').existsSync(dbPath)) return res.status(404).json({ error: '数据库文件不存在' });
  const date = new Date().toISOString().slice(0, 10);
  res.download(dbPath, `prs-backup-${date}.db`);
});

// ── Start (async for sql.js init) ──
const PORT = process.env.PORT || 3000;

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`产品评测管理系统 服务已启动: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
