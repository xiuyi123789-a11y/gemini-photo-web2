import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = path.join(root, '.local', 'releases');
fs.mkdirSync(releases, { recursive: true });
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean);
const added = run('git', ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
const excluded = /^(?:\.git|\.local|node_modules|data|dist|backups)(?:\/|$)/;
const files = [...new Set([...tracked, ...added])].filter(file => {
  if (excluded.test(file) || (file.startsWith('.env') && file !== '.env.tencent.example')) return false;
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep)) throw new Error('File outside project');
  if (!fs.existsSync(full)) return false;
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error(`Symlink not allowed in source export: ${file}`);
  return stat.isFile();
}).sort();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const archive = path.join(releases, `quantumleap-source-${stamp}.tar.gz`);
const manifest = path.join(releases, 'source-files.txt');
fs.writeFileSync(manifest, files.join('\n') + '\n');
run('tar', ['-czf', archive, '-C', root, '-T', manifest]);
const listing = run('tar', ['-tzf', archive]).trim().split(/\r?\n/).filter(Boolean);
if (listing.length !== files.length) throw new Error('Archive verification failed');
console.log(`Source archive: ${archive}\nVerified source files: ${files.length}`);
