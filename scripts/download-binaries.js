#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin', 'mac');
fs.mkdirSync(BIN_DIR, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`  ✓ already exists: ${path.basename(dest)}`);
      return resolve();
    }
    console.log(`  ↓ downloading: ${path.basename(dest)} ...`);
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
    get(url);
  });
}

async function main() {
  console.log('\n🎙  Grooveline Broadcaster — binary preparation\n');

  // ── ffmpeg ──────────────────────────────────────────────────────────────────
  const ffmpegDest = path.join(BIN_DIR, 'ffmpeg');
  if (fs.existsSync(ffmpegDest)) {
    console.log('  ✓ ffmpeg already present');
  } else {
    try {
      const tmpZip = path.join(BIN_DIR, 'ffmpeg.zip');
      await download('https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip', tmpZip);
      execSync(`unzip -o "${tmpZip}" ffmpeg -d "${BIN_DIR}"`, { stdio: 'pipe' });
      fs.unlinkSync(tmpZip);
      fs.chmodSync(ffmpegDest, 0o755);
      console.log('  ✅ ffmpeg ready');
    } catch (e) {
      console.error('  ❌ ffmpeg failed:', e.message);
      console.log('\n  Manual fix:\n  curl -L https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip -o /tmp/ff.zip && unzip /tmp/ff.zip -d bin/mac/ && chmod +x bin/mac/ffmpeg\n');
      process.exit(1);
    }
  }

  // ── sox ─────────────────────────────────────────────────────────────────────
  const soxDest = path.join(BIN_DIR, 'sox');
  if (fs.existsSync(soxDest)) {
    console.log('  ✓ sox already present');
  } else {
    let found = false;

    // Try homebrew locations
    const brewPaths = [
      '/usr/local/bin/sox',                          // Intel homebrew
      '/opt/homebrew/bin/sox',                       // Apple Silicon homebrew
    ];
    // Also try `brew --prefix sox`
    try {
      const prefix = execSync('brew --prefix sox 2>/dev/null', { encoding: 'utf8' }).trim();
      if (prefix) brewPaths.unshift(path.join(prefix, 'bin', 'sox'));
    } catch {}

    for (const p of brewPaths) {
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, soxDest);
        fs.chmodSync(soxDest, 0o755);
        console.log(`  ✅ sox copied from ${p}`);
        found = true;
        break;
      }
    }

    if (!found) {
      console.error('  ❌ sox not found in Homebrew paths');
      console.log('\n  Fix: brew install sox\n  Then re-run: npm run prepare-binaries\n');
      process.exit(1);
    }
  }

  // ── verify ──────────────────────────────────────────────────────────────────
  console.log('\n  Verifying binaries...');
  try {
    const ffVer = execSync(`"${ffmpegDest}" -version 2>&1 | head -1`, { encoding: 'utf8' }).trim();
    console.log(`  ffmpeg: ${ffVer.split('\n')[0]}`);
  } catch { console.warn('  ⚠ could not verify ffmpeg'); }

  try {
    const soxVer = execSync(`"${soxDest}" --version 2>&1`, { encoding: 'utf8' }).trim();
    console.log(`  sox:    ${soxVer}`);
  } catch { console.warn('  ⚠ could not verify sox'); }

  console.log('\n✅  All binaries ready — run: npm run dist:mac\n');
}

main().catch(e => { console.error(e); process.exit(1); });
