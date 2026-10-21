#!/usr/bin/env node
/**
 * Download Windows ffmpeg binary for bundling into the Electron app.
 * Run this on Windows (or cross-compile host) before: npm run dist:win
 *
 * Downloads ffmpeg from https://www.gyan.dev/ffmpeg/builds/ (trusted Windows builds)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin', 'win');
fs.mkdirSync(BIN_DIR, { recursive: true });

const FFMPEG_DEST = path.join(BIN_DIR, 'ffmpeg.exe');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`  ✓ already exists: ${path.basename(dest)}`);
      return resolve();
    }
    console.log(`  ↓ downloading: ${path.basename(dest)} ...`);
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
    get(url);
  });
}

async function main() {
  console.log('\n🎙  Grooveline Broadcaster — Windows binary preparation\n');

  if (fs.existsSync(FFMPEG_DEST)) {
    console.log('  ✓ ffmpeg.exe already present');
  } else {
    // gyan.dev essentials build — small, has libmp3lame
    const ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
    const tmpZip = path.join(BIN_DIR, 'ffmpeg-win.zip');

    try {
      await download(ZIP_URL, tmpZip);
      console.log('  📦 Extracting ffmpeg.exe...');

      if (process.platform === 'win32') {
        // Windows: use PowerShell to extract
        execSync(`powershell -Command "
          $zip = [System.IO.Compression.ZipFile]::OpenRead('${tmpZip.replace(/\\/g, '\\\\')}')
          $entry = $zip.Entries | Where-Object { $_.Name -eq 'ffmpeg.exe' }
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '${FFMPEG_DEST.replace(/\\/g, '\\\\')}', $true)
          $zip.Dispose()
        "`, { stdio: 'pipe' });
      } else {
        // macOS/Linux cross-build: use unzip
        execSync(`unzip -o "${tmpZip}" "*/bin/ffmpeg.exe" -d "${BIN_DIR}_tmp"`, { stdio: 'pipe' });
        const found = execSync(`find "${BIN_DIR}_tmp" -name "ffmpeg.exe"`, { encoding: 'utf8' }).trim();
        if (!found) throw new Error('ffmpeg.exe not found in zip');
        fs.copyFileSync(found, FFMPEG_DEST);
        execSync(`rm -rf "${BIN_DIR}_tmp"`);
      }

      fs.unlinkSync(tmpZip);
      console.log('  ✅ ffmpeg.exe ready');
    } catch (e) {
      console.error('  ❌ ffmpeg download failed:', e.message);
      console.log('\n  Manual fix:');
      console.log('  1. Download https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip');
      console.log('  2. Extract ffmpeg.exe from the bin/ folder inside the zip');
      console.log(`  3. Place it at: bin/win/ffmpeg.exe\n`);
      process.exit(1);
    }
  }

  console.log('\n✅  Windows binaries ready — run: npm run dist:win\n');
}

main().catch(e => { console.error(e); process.exit(1); });
