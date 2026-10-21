// Writes src/build-info.json (version, short commit, build date) so the app can show exactly which build it is.
// Runs as electron-builder's beforePack hook (package.json "build.beforePack"), so every packaged build gets it:
// a local `npm run build:linux`, CI's `npx electron-builder`, and the Mac stick kit, which builds from a
// `git archive` tarball without .git. There the commit comes from build/commit.txt, which git archive fills in
// (export-subst in .gitattributes). Also runnable by hand: `node scripts/stamp-build.js`.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    const sha = execSync('git rev-parse --short=7 HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (sha) return dirty ? `${sha}+dirty` : sha;
  } catch {}
  try {
    const t = fs.readFileSync(path.join(root, 'build', 'commit.txt'), 'utf8').trim();
    if (t && !t.includes('$Format')) return t.slice(0, 7);
  } catch {}
  return 'unknown';
}

module.exports = async function stampBuild() {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const info = { version, commit: commit(), date: new Date().toISOString() };
  fs.writeFileSync(path.join(root, 'src', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`  • build info  version=${info.version} commit=${info.commit} date=${info.date}`);
};

if (require.main === module) module.exports();
