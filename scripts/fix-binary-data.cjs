/**
 * @shinyoshiaki/binary-data stores its internal modules under src/node_modules/
 * (a non-standard pattern). electron-builder's smart pruner only follows the
 * declared `dependencies` in each package.json, so those internal modules are
 * excluded from the asar and the packaged app crashes with
 * "Cannot find module 'lib/binary-stream'".
 *
 * Fix: copy src/node_modules/ → node_modules/, add a package.json to each
 * sub-directory so electron-builder recognises them as proper packages, and
 * add them to @shinyoshiaki/binary-data/package.json#dependencies so the
 * pruner actually follows them.
 */
const fs = require('fs')
const path = require('path')

const pkgRoot = path.join(__dirname, '..', 'node_modules', '@shinyoshiaki', 'binary-data')
const srcMods = path.join(pkgRoot, 'src', 'node_modules')
const destMods = path.join(pkgRoot, 'node_modules')

if (!fs.existsSync(srcMods)) {
  console.log('[fix-binary-data] src/node_modules not found — skipping')
  process.exit(0)
}

// Copy src/node_modules → node_modules (idempotent)
fs.cpSync(srcMods, destMods, { recursive: true, force: false, errorOnExist: false })

// Add package.json to every sub-directory that doesn't have one
const subDirs = fs.readdirSync(destMods, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)

for (const dir of subDirs) {
  const pkgFile = path.join(destMods, dir, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(pkgFile, JSON.stringify({ name: dir, version: '0.0.1', main: 'binary-stream.js' }))
  }
}

// Patch @shinyoshiaki/binary-data/package.json to declare them as dependencies
// so electron-builder's dependency pruner includes them
const parentPkgFile = path.join(pkgRoot, 'package.json')
const parentPkg = JSON.parse(fs.readFileSync(parentPkgFile, 'utf8'))

let changed = false
for (const dir of subDirs) {
  if (!parentPkg.dependencies) parentPkg.dependencies = {}
  if (!parentPkg.dependencies[dir]) {
    parentPkg.dependencies[dir] = `file:./node_modules/${dir}`
    changed = true
  }
}

if (changed) {
  fs.writeFileSync(parentPkgFile, JSON.stringify(parentPkg, null, 2))
}

console.log('[fix-binary-data] patched @shinyoshiaki/binary-data — sub-modules:', subDirs.join(', '))
