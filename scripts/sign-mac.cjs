// Ad-hoc signs the macOS build. Without a signature Apple Silicon refuses to
// launch the app, and we have no Apple certificate. Order matters: nested
// binaries first, the bundle last, or the outer signature breaks.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: 'pipe',
  });
}

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const vendor = path.join(app, 'Contents', 'Resources', 'vendor', 'mac');

  if (fs.existsSync(vendor)) {
    for (const name of fs.readdirSync(vendor)) sign(path.join(vendor, name));
  }

  sign(app);

  // Better to fail here than to ship a .dmg that cannot open.
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'pipe' });
  console.log('  • ad-hoc signature applied and verified');
};
