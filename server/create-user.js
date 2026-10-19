import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openDatabase } from './database.js';
import { hashPassword, normalizeUsername } from './auth.js';
import { readPasswordFromStdin, validatePasswordInput } from './password-input.js';

let store;
let prompt;
try {
  const username = normalizeUsername(process.argv[2]);
  const args = process.argv.slice(3);
  if (!/^[a-z0-9_-]{3,40}$/.test(username) || args.length > 1 || (args.length && args[0] !== '--password-stdin')) {
    throw new Error('Usage: node server/create-user.js <username> [--password-stdin]. Never put a password in command arguments.');
  }
  let password;
  if (args[0] === '--password-stdin') {
    if (process.stdin.isTTY) throw new Error('--password-stdin requires a pipe. Use bash deploy/create-user.sh <username> for hidden terminal input.');
    password = await readPasswordFromStdin(process.stdin);
  } else {
    if (!process.stdin.isTTY) throw new Error('Use an interactive terminal or --password-stdin with a pipe');
    let muted = false;
    const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
    prompt = createInterface({ input: process.stdin, output, terminal: true });
    process.stdout.write('Password (12-256 characters, hidden): ');
    muted = true;
    password = await prompt.question('');
    muted = false;
    process.stdout.write(`\nReceived ${password.length} characters (password hidden).\n`);
    validatePasswordInput(password);
    process.stdout.write('Confirm password (hidden): ');
    muted = true;
    const confirmation = await prompt.question('');
    muted = false;
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match');
  }
  const hash = await hashPassword(password);
  password = undefined;
  store = await openDatabase();
  if (!store) throw new Error('Configure PostgreSQL before creating accounts');
  await store.createUser(username, hash);
  console.log(`Account created: ${username}`);
} catch (error) {
  console.error(error.code === '23505' ? 'Username already exists' : error.message);
  process.exitCode = 1;
} finally {
  prompt?.close();
  await store?.pool.end();
}
