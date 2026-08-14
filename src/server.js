import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');
const JWT_SECRET = process.env.JWT_SECRET;
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const poolConfig = process.env.DATABASE_URL ? { uri: process.env.DATABASE_URL } : {
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'taskmanager'
};
const pool = mysql.createPool({ ...poolConfig, waitForConnections: true, connectionLimit: 10, queueLimit: 0, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
const smtpReady = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const mailer = smtpReady ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) : null;

async function query(sql, params = []) { const [rows] = await pool.execute(sql, params); return rows; }
const normalizeUsername = value => String(value || '').trim().toLowerCase();
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const validUsername = username => /^[a-z0-9_.-]{3,50}$/.test(username);
const validPassword = password => typeof password === 'string' && password.length >= 8;
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, isActive: Boolean(u.is_active), mustChangePassword: Boolean(u.must_change_password), emailVerified: Boolean(u.email_verified) });
const issueToken = u => jwt.sign({ id: u.id, username: u.username, name: u.name, role: u.role, mustChangePassword: Boolean(u.must_change_password) }, JWT_SECRET, { expiresIn: '7d' });

async function init() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(50) UNIQUE NULL, name VARCHAR(100) NOT NULL,
    email VARCHAR(160) UNIQUE NULL, password_hash VARCHAR(255) NULL, password TEXT NULL,
    role ENUM('admin','member') NOT NULL DEFAULT 'member', is_active BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT TRUE, email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS otp_codes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, purpose ENUM('email_verify','password_reset','login') NOT NULL,
    email VARCHAR(160) NOT NULL, otp_hash VARCHAR(255) NOT NULL, expires_at DATETIME NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0, consumed_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_otp_lookup(user_id, purpose, consumed_at, expires_at), CONSTRAINT fk_otp_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS projects (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(150) NOT NULL, description TEXT, owner_id INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, CONSTRAINT fk_projects_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS project_members (project_id INT NOT NULL, user_id INT NOT NULL, PRIMARY KEY(project_id,user_id), CONSTRAINT fk_pm_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE, CONSTRAINT fk_pm_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS tasks (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(180) NOT NULL, description TEXT, status ENUM('todo','in_progress','done') NOT NULL DEFAULT 'todo', priority ENUM('low','medium','high') NOT NULL DEFAULT 'medium', due_date DATE NULL, project_id INT NOT NULL, assignee_id INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, CONSTRAINT fk_tasks_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE, CONSTRAINT fk_tasks_assignee FOREIGN KEY(assignee_id) REFERENCES users(id) ON DELETE SET NULL) ENGINE=InnoDB`);
  const columns = await query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`);
  const names = new Set(columns.map(c => c.COLUMN_NAME));
  const add = async (name, definition) => { if (!names.has(name)) await query(`ALTER TABLE users ADD COLUMN ${name} ${definition}`); };
  await add('username', 'VARCHAR(50) UNIQUE NULL AFTER id'); await add('password_hash', 'VARCHAR(255) NULL');
  await add('is_active', 'BOOLEAN NOT NULL DEFAULT TRUE'); await add('must_change_password', 'BOOLEAN NOT NULL DEFAULT TRUE'); await add('email_verified', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await query('ALTER TABLE users MODIFY email VARCHAR(160) NULL');
  if (names.has('password')) {
    await query('UPDATE users SET password_hash=password WHERE password_hash IS NULL AND password IS NOT NULL');
    await query('ALTER TABLE users MODIFY password TEXT NULL');
  }
  const missing = await query('SELECT id, email FROM users WHERE username IS NULL');
  for (const u of missing) await query('UPDATE users SET username=? WHERE id=?', [`user_${u.id}`, u.id]);
  const count = await query('SELECT COUNT(*) AS count FROM users');
  if (!Number(count[0].count) && process.env.ADMIN_USERNAME && process.env.ADMIN_NAME && process.env.ADMIN_TEMP_PASSWORD) {
    const username = normalizeUsername(process.env.ADMIN_USERNAME);
    if (!validUsername(username) || !validPassword(process.env.ADMIN_TEMP_PASSWORD)) throw new Error('Bootstrap admin username or temporary password is invalid');
    await query('INSERT INTO users(username,name,password_hash,role,is_active,must_change_password) VALUES(?,?,?,?,TRUE,TRUE)', [username, process.env.ADMIN_NAME.trim(), await bcrypt.hash(process.env.ADMIN_TEMP_PASSWORD, 12), 'admin']);
    console.log(`Bootstrap admin created: ${username}`);
  }
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || ''; if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Login required' });
    const claims = jwt.verify(header.slice(7), JWT_SECRET); const rows = await query('SELECT * FROM users WHERE id=?', [claims.id]);
    if (!rows.length || !rows[0].is_active) return res.status(401).json({ error: 'Account is inactive or unavailable' });
    req.user = rows[0]; next();
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}
function passwordChanged(req, res, next) { if (req.user.must_change_password) return res.status(403).json({ error: 'Change your temporary password before accessing the application', code: 'PASSWORD_CHANGE_REQUIRED' }); next(); }
function ready(req, res, next) { passwordChanged(req, res, () => { if (!req.user.email_verified) return res.status(403).json({ error: 'Verify an email address before accessing the application', code: 'EMAIL_VERIFICATION_REQUIRED' }); next(); }); }
function admin(req, res, next) { if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' }); next(); }
function randomOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
async function sendOtp(user, purpose, email) {
  if (!mailer) throw new Error('Email delivery is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS.');
  const recent = await query(`SELECT COUNT(*) AS count FROM otp_codes WHERE user_id=? AND purpose=? AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`, [user.id, purpose]);
  if (Number(recent[0].count) >= 3) { const error = new Error('Too many OTP requests. Try again later.'); error.status = 429; throw error; }
  const otp = randomOtp();
  await query('UPDATE otp_codes SET consumed_at=NOW() WHERE user_id=? AND purpose=? AND consumed_at IS NULL', [user.id, purpose]);
  await query('INSERT INTO otp_codes(user_id,purpose,email,otp_hash,expires_at) VALUES(?,?,?,?,DATE_ADD(NOW(), INTERVAL 5 MINUTE))', [user.id, purpose, email, await bcrypt.hash(otp, 12)]);
  await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email, subject: 'Team Task Manager verification code', text: `Your ${purpose.replace('_', ' ')} code is ${otp}. It expires in 5 minutes.` });
}
async function consumeOtp(userId, purpose, code, email = null) {
  const rows = await query(`SELECT * FROM otp_codes WHERE user_id=? AND purpose=? AND consumed_at IS NULL AND expires_at > NOW() ${email ? 'AND email=?' : ''} ORDER BY id DESC LIMIT 1`, email ? [userId, purpose, email] : [userId, purpose]);
  if (!rows.length) { const error = new Error('OTP is invalid or expired'); error.status = 400; throw error; }
  const otp = rows[0];
  if (otp.attempts >= OTP_MAX_ATTEMPTS) { const error = new Error('Too many OTP attempts. Request a new code.'); error.status = 429; throw error; }
  const valid = await bcrypt.compare(String(code || ''), otp.otp_hash);
  if (!valid) { await query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?', [otp.id]); const error = new Error('OTP is invalid'); error.status = 400; throw error; }
  await query('UPDATE otp_codes SET consumed_at=NOW() WHERE id=?', [otp.id]); return otp;
}
const asyncRoute = handler => (req, res) => Promise.resolve(handler(req, res)).catch(e => { console.error(e); res.status(e.status || 500).json({ error: e.message || 'Server error' }); });

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username); const rows = await query('SELECT * FROM users WHERE username=?', [username]);
  if (!rows.length || !rows[0].is_active || !(await bcrypt.compare(req.body.password || '', rows[0].password_hash || ''))) return res.status(401).json({ error: 'Invalid username or password' });
  const u = rows[0]; res.json({ user: publicUser(u), token: issueToken(u), mustChangePassword: Boolean(u.must_change_password) });
}));
app.post('/api/auth/change-temporary-password', auth, asyncRoute(async (req, res) => {
  if (!validPassword(req.body.password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  await query('UPDATE users SET password_hash=?, must_change_password=FALSE WHERE id=?', [await bcrypt.hash(req.body.password, 12), req.user.id]);
  const u = (await query('SELECT * FROM users WHERE id=?', [req.user.id]))[0]; res.json({ user: publicUser(u), token: issueToken(u) });
}));
app.post('/api/auth/email/request', auth, passwordChanged, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email); if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  const exists = await query('SELECT id FROM users WHERE email=? AND id<>?', [email, req.user.id]); if (exists.length) return res.status(409).json({ error: 'Email is already in use' });
  await sendOtp(req.user, 'email_verify', email); res.json({ message: 'OTP sent to your email' });
}));
app.post('/api/auth/email/verify', auth, passwordChanged, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email); await consumeOtp(req.user.id, 'email_verify', req.body.otp, email);
  await query('UPDATE users SET email=?, email_verified=TRUE WHERE id=?', [email, req.user.id]); const u = (await query('SELECT * FROM users WHERE id=?', [req.user.id]))[0]; res.json({ user: publicUser(u), token: issueToken(u) });
}));
app.post('/api/auth/forgot-password/request', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username); const rows = await query('SELECT * FROM users WHERE username=? AND is_active=TRUE', [username]);
  if (rows.length && rows[0].email_verified && rows[0].email) await sendOtp(rows[0], 'password_reset', rows[0].email);
  res.json({ message: 'If the account has a verified email, an OTP has been sent.' });
}));
app.post('/api/auth/forgot-password/verify', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username); const rows = await query('SELECT * FROM users WHERE username=? AND is_active=TRUE', [username]); if (!rows.length) return res.status(400).json({ error: 'Invalid reset request' });
  await consumeOtp(rows[0].id, 'password_reset', req.body.otp); if (!validPassword(req.body.password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  await query('UPDATE users SET password_hash=?, must_change_password=FALSE WHERE id=?', [await bcrypt.hash(req.body.password, 12), rows[0].id]); res.json({ message: 'Password reset successfully' });
}));
app.post('/api/auth/login-otp/request', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username); const rows = await query('SELECT * FROM users WHERE username=? AND is_active=TRUE', [username]);
  if (rows.length && rows[0].email_verified && rows[0].email) await sendOtp(rows[0], 'login', rows[0].email);
  res.json({ message: 'If the account has a verified email, an OTP has been sent.' });
}));
app.post('/api/auth/login-otp/verify', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username); const rows = await query('SELECT * FROM users WHERE username=? AND is_active=TRUE', [username]); if (!rows.length) return res.status(401).json({ error: 'Invalid OTP login' });
  const u = rows[0]; await consumeOtp(u.id, 'login', req.body.otp); res.json({ user: publicUser(u), token: issueToken(u), mustChangePassword: Boolean(u.must_change_password) });
}));
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/admin/users', auth, ready, admin, asyncRoute(async (req, res) => res.json(await query('SELECT id,username,name,email,role,is_active,must_change_password,email_verified,created_at FROM users ORDER BY name'))));
app.post('/api/admin/users', auth, ready, admin, asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username), name = String(req.body.name || '').trim(), role = req.body.role;
  if (!validUsername(username) || !name || !validPassword(req.body.temporaryPassword) || !['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Username (3-50 letters, numbers, . _ -), name, 8+ character temporary password and valid role are required' });
  const result = await query('INSERT INTO users(username,name,password_hash,role,is_active,must_change_password) VALUES(?,?,?,?,TRUE,TRUE)', [username, name, await bcrypt.hash(req.body.temporaryPassword, 12), role]);
  const u = (await query('SELECT * FROM users WHERE id=?', [result.insertId]))[0]; res.status(201).json(publicUser(u));
}));
app.patch('/api/admin/users/:id', auth, ready, admin, asyncRoute(async (req, res) => {
  const target = (await query('SELECT * FROM users WHERE id=?', [req.params.id]))[0]; if (!target) return res.status(404).json({ error: 'User not found' });
  if (Object.hasOwn(req.body, 'isActive')) { if (target.id === req.user.id && !req.body.isActive) return res.status(400).json({ error: 'You cannot deactivate yourself' }); await query('UPDATE users SET is_active=? WHERE id=?', [Boolean(req.body.isActive), target.id]); }
  if (Object.hasOwn(req.body, 'role')) { if (!['admin', 'member'].includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' }); if (target.id === req.user.id && req.body.role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role' }); await query('UPDATE users SET role=? WHERE id=?', [req.body.role, target.id]); }
  const u = (await query('SELECT * FROM users WHERE id=?', [target.id]))[0]; res.json(publicUser(u));
}));
app.post('/api/admin/users/:id/reset-password', auth, ready, admin, asyncRoute(async (req, res) => { if (!validPassword(req.body.temporaryPassword)) return res.status(400).json({ error: 'Temporary password must be at least 8 characters' }); const r = await query('UPDATE users SET password_hash=?,must_change_password=TRUE WHERE id=?', [await bcrypt.hash(req.body.temporaryPassword, 12), req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'User not found' }); res.json({ message: 'Temporary password reset' }); }));
app.get('/api/users', auth, ready, asyncRoute(async (req, res) => res.json(await query('SELECT id,username,name,email,role FROM users WHERE is_active=TRUE ORDER BY name'))));

app.get('/api/projects', auth, ready, asyncRoute(async (req, res) => res.json(await query(`SELECT p.*,u.name owner_name,(SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) task_count,(SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='done') done_count FROM projects p LEFT JOIN users u ON u.id=p.owner_id ORDER BY p.created_at DESC`))));
app.post('/api/projects', auth, ready, asyncRoute(async (req, res) => { const { name, description = '' } = req.body; if (!name?.trim()) return res.status(400).json({ error: 'Project name required' }); const r = await query('INSERT INTO projects(name,description,owner_id) VALUES(?,?,?)', [name.trim(), description, req.user.id]); await query('INSERT IGNORE INTO project_members(project_id,user_id) VALUES(?,?)', [r.insertId, req.user.id]); res.status(201).json((await query('SELECT * FROM projects WHERE id=?', [r.insertId]))[0]); }));
app.post('/api/projects/:id/members', auth, ready, admin, asyncRoute(async (req, res) => { await query('INSERT IGNORE INTO project_members(project_id,user_id) VALUES(?,?)', [req.params.id, req.body.userId]); res.json({ ok: true }); }));
app.get('/api/tasks', auth, ready, asyncRoute(async (req, res) => { const params = []; let where = ''; if (req.query.projectId) { params.push(req.query.projectId); where = 'WHERE t.project_id=?'; } res.json(await query(`SELECT t.*,p.name project_name,u.name assignee_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id ${where} ORDER BY t.created_at DESC`, params)); }));
app.post('/api/tasks', auth, ready, asyncRoute(async (req, res) => { const { title, description = '', status = 'todo', priority = 'medium', dueDate = null, projectId, assigneeId = null } = req.body; if (!title?.trim() || !projectId) return res.status(400).json({ error: 'Title and project are required' }); const r = await query('INSERT INTO tasks(title,description,status,priority,due_date,project_id,assignee_id) VALUES(?,?,?,?,?,?,?)', [title.trim(), description, status, priority, dueDate || null, projectId, assigneeId || null]); res.status(201).json((await query('SELECT * FROM tasks WHERE id=?', [r.insertId]))[0]); }));
app.patch('/api/tasks/:id', auth, ready, asyncRoute(async (req, res) => { const map = { title: 'title', description: 'description', status: 'status', priority: 'priority', dueDate: 'due_date', assigneeId: 'assignee_id' }; const key = Object.keys(map).find(k => Object.hasOwn(req.body, k)); if (!key) return res.status(400).json({ error: 'No editable field' }); const r = await query(`UPDATE tasks SET ${map[key]}=? WHERE id=?`, [req.body[key] ?? null, req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Task not found' }); res.json((await query('SELECT * FROM tasks WHERE id=?', [req.params.id]))[0]); }));
app.delete('/api/tasks/:id', auth, ready, admin, asyncRoute(async (req, res) => { await query('DELETE FROM tasks WHERE id=?', [req.params.id]); res.status(204).end(); }));
app.get('/api/dashboard', auth, ready, asyncRoute(async (req, res) => res.json((await query(`SELECT COUNT(*) AS total, SUM(status='todo') AS todo, SUM(status='in_progress') AS in_progress, SUM(status='done') AS done, SUM(due_date < CURDATE() AND status <> 'done') AS overdue FROM tasks`))[0])));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
const PORT = Number(process.env.PORT || 3000);
init().then(() => app.listen(PORT, () => console.log(`Task Manager running at http://localhost:${PORT}`))).catch(e => { console.error(e); process.exit(1); });
