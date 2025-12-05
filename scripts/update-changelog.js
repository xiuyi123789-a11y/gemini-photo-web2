import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🛠️ 自动适配路径：无论脚本在根目录还是 scripts 目录都能找到 src
const projectRoot = __dirname.includes('scripts') ? path.join(__dirname, '..') : __dirname;
const CHANGELOG_PATH = path.join(projectRoot, 'src/data/changelog.json');

function getLatestCommit() {
  try {
    // 加上 stdio: 'pipe' 防止在没有 git 的环境报错输出干扰
    const msg = execSync('git log -1 --pretty=%B', { stdio: 'pipe' }).toString().trim();
    const date = execSync('git log -1 --pretty=%ad --date=short', { stdio: 'pipe' }).toString().trim();
    return { msg, date };
  } catch (e) {
    console.warn('⚠️ Warning: Git command failed. Using fallback data.');
    return {
        msg: 'Update: Manual deployment',
        date: new Date().toISOString().split('T')[0]
    };
  }
}

function parseCommitMessage(fullMsg) {
  const lines = fullMsg.split('\n').filter(l => l.trim());
  const summary = lines[0] || 'System Update';
  let details = lines.slice(1).join('\n').trim();
  
  details = details.replace(/^-\s+/gm, '• ');

  let type = 'Update';
  const lowerSum = summary.toLowerCase();
  if (lowerSum.startsWith('fix')) type = 'Fix';
  else if (lowerSum.startsWith('feat')) type = 'Feature';
  else if (lowerSum.startsWith('perf')) type = 'Performance';
  
  return { summary, details, type };
}

function bumpVersion(lastVersion) {
  if (!lastVersion) return 'v1.0.0';
  const parts = lastVersion.replace('v', '').split('.').map(Number);
  parts[2]++; // 增加修订号 (Patch)
  return `v${parts.join('.')}`;
}

function updateChangelog() {
  // 🛠️ 自动创建目录和文件（如果不存在）
  if (!fs.existsSync(CHANGELOG_PATH)) {
    console.log('Changelog file not found. Creating new one...');
    const dir = path.dirname(CHANGELOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHANGELOG_PATH, '[]', 'utf-8');
  }

  let changelog = [];
  try {
    const content = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
    changelog = content ? JSON.parse(content) : [];
  } catch (e) {
    console.error('Error parsing changelog JSON, resetting to empty array.');
    changelog = [];
  }

  const { msg, date } = getLatestCommit();
  const { summary, details, type } = parseCommitMessage(msg);

  // 防止重复记录 (如果最新的那条 summary 和当前一样，就不加了)
  if (changelog.length > 0 && changelog[0].changes[0].summary === summary) {
    console.log('✨ Changelog already up to date.');
    return;
  }

  const newVersion = bumpVersion(changelog[0]?.version);

  const newEntry = {
    version: newVersion,
    date: date,
    changes: [
      {
        summary,
        details
      }
    ],
    type
  };

  changelog.unshift(newEntry);

  fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2));
  console.log(`✅ Changelog updated to ${newVersion}: ${summary}`);
}

updateChangelog();