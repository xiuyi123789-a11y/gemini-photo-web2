import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openDatabase } from './database.js';
import { hashPassword, normalizeUsername } from './auth.js';

const username = normalizeUsername(process.argv[2]);
if (!/^[a-z0-9_-]{3,40}$/.test(username)) throw new Error('Usage: node server/create-user.js <username: 3-40 letters/digits/_/->');
if (!process.stdin.isTTY) throw new Error('Run interactively in a terminal; do not put passwords in command arguments.');
let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
const prompt = createInterface({ input: process.stdin, output, terminal: true });
let store;
try {
  store = await openDatabase();
  if (!store) throw new Error('Configure PostgreSQL before creating accounts');
  process.stdout.write('Password (12-256 characters, hidden): ');
  muted = true;
  const password = await prompt.question('');
  muted = false;
  process.stdout.write('\nConfirm password (hidden): ');
  muted = true;
  const confirmation = await prompt.question('');
  muted = false;
  process.stdout.write('\n');
  if (password !== confirmation) throw new Error('Passwords do not match');
  await store.createUser(username, await hashPassword(password));
  console.log(`Account created: ${username}`);
} catch (error) {
  console.error(error.code === '23505' ? 'Username already exists' : error.message);
  process.exitCode = 1;
} finally {
  prompt.close();
  await store?.pool.end();
}
