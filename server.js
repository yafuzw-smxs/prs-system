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
  console.log(`[GET /api/tables] user=${req.user.username} tables=${result.tables.length} updatedBy=${result.updatedBy} updatedAt=${result.updatedAt}`);
  res.json(result);
});

// ── API: Save shared tables ──
app.put('/api/tables', authMiddleware, (req, res) => {
  const { tables } = req.body || {};
  if (!Array.isArray(tables)) return res.status(400).json({ error: '无效数据' });
  try {
    db.saveTables(JSON.stringify(tables), req.user.username);
    console.log(`[PUT /api/tables] user=${req.user.username} tables=${tables.length} bodyBytes=${JSON.stringify(tables).length}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[PUT /api/tables] ERROR user=${req.user.username}:`, e.message);
    res.status(500).json({ error: '保存失败: ' + e.message });
  }
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

// ── Auto cleanup old logs (older than 7 days) ──
function runLogCleanup() {
  try {
    const deleted = db.cleanupOldLogs();
    if (deleted > 0) console.log(`[日志清理] 已删除 ${deleted} 条超过 7 天的日志`);
  } catch (e) { console.error('[日志清理] 失败:', e.message); }
}
// Run on startup and every 6 hours
setTimeout(runLogCleanup, 8000);
setInterval(runLogCleanup, 6 * 60 * 60 * 1000);

// ── API: Manual backup download (需登录) ──
app.get('/api/backup', authMiddleware, (req, res) => {
  db.save(); // flush to disk first
  const dbPath = path.join(__dirname, 'data', 'prs.db');
  if (!require('fs').existsSync(dbPath)) return res.status(404).json({ error: '数据库文件不存在' });
  const date = new Date().toISOString().slice(0, 10);
  res.download(dbPath, `prs-backup-${date}.db`);
});

// ── API: 紧急备份下载（无需登录，用 BACKUP_TOKEN 环境变量鉴权）──
// 用法：GET /api/emergency-backup?token=你的密钥
//       GET /api/emergency-backup?token=你的密钥&file=prs-backup-2026-04-27  （下载指定日期备份）
// 配置：在 Railway 控制台 Variables 里添加 BACKUP_TOKEN=随机字符串
app.get('/api/emergency-backup', (req, res) => {
  const secret = process.env.BACKUP_TOKEN;
  if (!secret) return res.status(503).json({ error: '未配置 BACKUP_TOKEN 环境变量，紧急下载已禁用' });
  if (req.query.token !== secret) return res.status(401).json({ error: 'token 错误' });

  const fs = require('fs');
  const dataDir = path.join(__dirname, 'data');

  // 列出可用备份
  if (req.query.list === '1') {
    const backupDir = path.join(dataDir, 'backups');
    const files = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort().reverse()
      : [];
    const mainExists = fs.existsSync(path.join(dataDir, 'prs.db'));
    return res.json({ main: mainExists ? 'prs.db (当前数据库)' : null, backups: files });
  }

  // 下载指定历史备份
  if (req.query.file) {
    const name = path.basename(req.query.file) + (req.query.file.endsWith('.db') ? '' : '.db');
    const filePath = path.join(dataDir, 'backups', name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '备份文件不存在: ' + name });
    return res.download(filePath, name);
  }

  // 默认：下载当前数据库
  db.save();
  const dbPath = path.join(dataDir, 'prs.db');
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: '数据库文件不存在' });
  const date = new Date().toISOString().slice(0, 10);
  res.download(dbPath, `prs-emergency-${date}.db`);
});

// ── API: 一次性数据库恢复接口（用 BACKUP_TOKEN 鉴权）──
// 用法：curl -X POST -H "Content-Type: application/octet-stream" \
//         --data-binary @prs.db \
//         "https://prs-system.fly.dev/api/admin/restore-db?token=YOUR_TOKEN"
// 服务器把上传内容写入 /app/data/prs-staged.db，然后 process.exit(0)
// db.js 的 init() 在启动时若发现 staged 文件，会先把它换成 prs.db 再加载
app.post('/api/admin/restore-db',
  express.raw({ type: '*/*', limit: '100mb' }),
  (req, res) => {
    const secret = process.env.BACKUP_TOKEN;
    if (!secret) return res.status(503).json({ error: '未配置 BACKUP_TOKEN' });
    if (req.query.token !== secret) return res.status(401).json({ error: 'token 错误' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: '请求体为空，请用 --data-binary @file.db' });
    const fs = require('fs');
    const stagedPath = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'prs-staged.db');
    try {
      fs.writeFileSync(stagedPath, req.body);
      console.log('[restore] 已写入 staged 文件:', stagedPath, '大小:', req.body.length);
      res.json({ ok: true, size: req.body.length, msg: '已上传，2秒后进程退出，Fly 会自动重启并加载新数据' });
      setTimeout(() => {
        console.log('[restore] 主动退出进程，等待 Fly 重启加载新数据');
        process.exit(0);
      }, 2000);
    } catch (e) {
      console.error('[restore] 写入失败:', e.message);
      res.status(500).json({ error: '写入失败: ' + e.message });
    }
  }
);

// ── Start (async for sql.js init) ──
const PORT = process.env.PORT || 3000;

// 启动时打印环境变量诊断信息（不泄露实际值）
console.log('[ENV] BACKUP_TOKEN 是否设置:', !!process.env.BACKUP_TOKEN);
console.log('[ENV] BACKUP_TOKEN 长度:', (process.env.BACKUP_TOKEN || '').length);
console.log('[ENV] BACKUP_TOKEN 前2位:', (process.env.BACKUP_TOKEN || '').slice(0, 2));
console.log('[ENV] DATA_DIR:', process.env.DATA_DIR || '(未设置)');
console.log('[ENV] RAILWAY_VOLUME_MOUNT_PATH:', process.env.RAILWAY_VOLUME_MOUNT_PATH || '(未设置)');
console.log('[ENV] RAILWAY_ENVIRONMENT_NAME:', process.env.RAILWAY_ENVIRONMENT_NAME || '(未设置)');
console.log('[ENV] 所有以 BACKUP 开头的变量:', Object.keys(process.env).filter(k => k.toUpperCase().includes('BACKUP')));

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`产品评测管理系统 服务已启动: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
