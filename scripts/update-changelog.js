import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHANGELOG_PATH = path.join(__dirname, '../src/data/changelog.json');

function getLatestCommit() {
  try {
    const msg = execSync('git log -1 --pretty=%B').toString().trim();
    const date = execSync('git log -1 --pretty=%ad --date=short').toString().trim();
    return { msg, date };
  } catch (e) {
    console.error('Failed to get git log:', e);
    process.exit(1);
  }
}

function parseCommitMessage(fullMsg) {
  const lines = fullMsg.split('\n').filter(l => l.trim());
  const summary = lines[0];
  let details = lines.slice(1).join('\n').trim();
  
  // Clean up git commit bullets if present
  details = details.replace(/^-\s+/gm, '• ');

  let type = 'Update';
  if (summary.toLowerCase().startsWith('fix')) type = 'Fix';
  else if (summary.toLowerCase().startsWith('feat')) type = 'Feature';
  
  return { summary, details, type };
}

function bumpVersion(lastVersion) {
  if (!lastVersion) return 'v1.0.0';
  const parts = lastVersion.replace('v', '').split('.').map(Number);
  // Simple patch bump
  parts[2]++;
  return `v${parts.join('.')}`;
}

function updateChangelog() {
  if (!fs.existsSync(CHANGELOG_PATH)) {
    console.error(`Changelog file not found at ${CHANGELOG_PATH}`);
    process.exit(1);
  }

  const changelog = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf-8'));
  const { msg, date } = getLatestCommit();
  const { summary, details, type } = parseCommitMessage(msg);

  // Prevent duplicate entries if running multiple times for same commit
  if (changelog.length > 0 && changelog[0].summary === summary) {
    console.log('Changelog already up to date for this commit.');
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
  console.log(`Changelog updated to ${newVersion}`);
}

updateChangelog();
