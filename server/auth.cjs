const crypto = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(crypto.scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function initAuth(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS admins (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);`);
}
async function hashPassword(password) {
 const salt = crypto.randomBytes(16).toString('hex');
 const key = await derive(password, salt, 64, options);
 return salt + ':' + key.toString('hex');
}
async function verifyPassword(password, encoded) {
 const [salt, hex] = encoded.split(':');
 const key = await derive(password, salt, 64, options);
 return crypto.timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
function session(db, req) {
 const match = (req.headers.cookie || '').match(/(?:^|;\s*)khotwa_session=([a-f0-9]{64})(?:;|$)/);
 if (!match) return null;
 return db.prepare('SELECT * FROM admin_sessions WHERE token_hash=? AND expires>?').get(tokenHash(match[1]), Date.now()) || null;
}
function cookie(token, maxAge) {
 return `khotwa_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` + (process.env.NODE_ENV === 'production' ? '; Secure' : '');
}
module.exports = {initAuth, hashPassword, verifyPassword, tokenHash, session, cookie};
