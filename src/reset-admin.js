import 'dotenv/config';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const password = process.env.ADMIN_TEMP_PASSWORD || '';

if (!/^[a-z0-9_.-]{3,50}$/.test(username) || password.length < 8) {
  throw new Error('Set ADMIN_USERNAME and an 8+ character ADMIN_TEMP_PASSWORD in .env before running this command.');
}

const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
const poolConfig = databaseUrl || {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'taskmanager'
};
const connection = await mysql.createConnection({
  ...poolConfig,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

try {
  const passwordHash = await bcrypt.hash(password, 12);
  const [result] = await connection.execute(
    `UPDATE users
     SET password_hash=?, role='admin', is_active=TRUE, must_change_password=TRUE
     WHERE username=?`,
    [passwordHash, username]
  );
  if (result.affectedRows) {
    console.log(`Admin account reset: ${username}. Sign in with ADMIN_TEMP_PASSWORD and choose a new password.`);
  } else {
    const name = String(process.env.ADMIN_NAME || '').trim();
    if (!name) throw new Error('ADMIN_NAME must be set to create a missing administrator.');
    const [legacyPasswordColumn] = await connection.execute("SHOW COLUMNS FROM users LIKE 'password'");
    const fields = ['username', 'name', 'password_hash', 'role', 'is_active', 'must_change_password', 'email_verified'];
    const values = [username, name, passwordHash, 'admin', true, true, false];
    if (legacyPasswordColumn.length) { fields.splice(3, 0, 'password'); values.splice(3, 0, passwordHash); }
    await connection.execute(`INSERT INTO users(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`, values);
    console.log(`Admin account created: ${username}. Sign in with ADMIN_TEMP_PASSWORD and choose a new password.`);
  }
} finally {
  await connection.end();
}
