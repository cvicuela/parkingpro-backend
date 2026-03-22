/**
 * Bundle Script
 *
 * Copies the backend, built PWA, and built App into bundled/ directory
 * for packaging with electron-builder.
 *
 * - Backend code + node_modules → bundled/backend/
 * - PWA dist → bundled/backend/public/       (served at /)
 * - App dist → bundled/backend/public/admin/  (served at /admin)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUNDLED = path.join(ROOT, 'bundled', 'backend');
const BACKEND_SRC = path.join(ROOT, '..');  // backend repo root
const PWA_DIST = path.join(ROOT, '..', '..', 'parkingpro-pwa', 'dist');
const APP_DIST = path.join(ROOT, '..', '..', 'parkingpro-app', 'dist');

function copyRecursive(src, dest, exclude = []) {
  if (!fs.existsSync(src)) {
    console.error(`  ERROR: Source not found: ${src}`);
    process.exit(1);
  }

  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath, exclude);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.log('ParkingPro Bundle Script');
console.log('========================\n');

// Clean
console.log('1. Cleaning bundled/ directory...');
rmrf(path.join(ROOT, 'bundled'));

// Copy backend (exclude dev files, tests, .git)
console.log('2. Copying backend...');
copyRecursive(BACKEND_SRC, BUNDLED, [
  '.git', '.github', 'tests', '__tests__', 'test',
  '.env.example', '.eslintrc.js', '.prettierrc',
  'coverage', '.nyc_output', 'nodemon.json',
]);
console.log('   Backend copied.');

// Copy PWA dist → public/
console.log('3. Copying PWA build...');
if (!fs.existsSync(PWA_DIST)) {
  console.error('   ERROR: PWA not built. Run "npm run build:pwa" first.');
  process.exit(1);
}
const publicDir = path.join(BUNDLED, 'public');
fs.mkdirSync(publicDir, { recursive: true });
copyRecursive(PWA_DIST, publicDir);
console.log('   PWA → public/');

// Copy App dist → public/admin/
console.log('4. Copying App build...');
if (!fs.existsSync(APP_DIST)) {
  console.error('   ERROR: App not built. Run "npm run build:app" first.');
  process.exit(1);
}
const adminDir = path.join(publicDir, 'admin');
fs.mkdirSync(adminDir, { recursive: true });
copyRecursive(APP_DIST, adminDir);
console.log('   App → public/admin/');

// Create a .env.template for the user
const envTemplate = `# ParkingPro Local Configuration
# Copy this file to .env and edit as needed

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/parkingpro
DB_HOST=localhost
DB_PORT=5432
DB_NAME=parkingpro
DB_USER=postgres
DB_PASSWORD=postgres

# Server
PORT=3000
NODE_ENV=production
DEPLOYMENT_MODE=local

# JWT Secret (CHANGE THIS in production)
JWT_SECRET=parkingpro-local-secret-change-me

# Optional: Supabase (for hybrid/remote mode)
# SUPABASE_URL=
# SUPABASE_ANON_KEY=
# SUPABASE_SERVICE_KEY=
`;

fs.writeFileSync(path.join(BUNDLED, '.env.template'), envTemplate);
console.log('5. Created .env.template');

// Summary
const countFiles = (dir) => {
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) count += countFiles(path.join(dir, e.name));
    else count++;
  }
  return count;
};

console.log(`\nBundle complete!`);
console.log(`  Total files: ${countFiles(BUNDLED)}`);
console.log(`  Location: ${BUNDLED}`);
