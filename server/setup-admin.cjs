const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const auth = require('./auth.cjs');
const directory = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../data'));
fs.mkdirSync(directory, {recursive:true});
const db = new DatabaseSync(path.join(directory, 'races.sqlite'));
auth.initAuth(db);
const rl = readline.createInterface({input:process.stdin, output:process.stdout});
const ask = prompt => new Promise(resolve => rl.question(prompt, resolve));
async function secret(prompt) {
 if (!process.stdin.isTTY) return ask(prompt);
 const previous = rl._writeToOutput;
 process.stdout.write(prompt);
 rl._writeToOutput = () => {};
 try { return await ask(''); } finally { rl._writeToOutput = previous; process.stdout.write('\n'); }
}
(async()=>{
 try {
 const username = (await ask('Admin username: ')).trim();
 if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) throw Error('Username: 3-50 letters, numbers, dots, dashes or underscores.');
 const password = await secret('Password (minimum 12 characters): ');
 if (password.length < 12 || password.length > 128) throw Error('Password must have 12-128 characters.');
 if (password !== await secret('Confirm password: ')) throw Error('Passwords do not match.');
 db.prepare('INSERT INTO admins (username,password_hash) VALUES (?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash').run(username, await auth.hashPassword(password));
 db.prepare('DELETE FROM admin_sessions WHERE username=?').run(username);
 console.log('Admin saved. Run npm start, then open http://localhost:3000/admin.html');
 } catch(e) {console.error(e.message);process.exitCode=1;} finally {rl.close();db.close();}
})();
