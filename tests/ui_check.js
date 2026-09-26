'use strict';
/* UI audit — cross-checks every getElementById() in the page scripts against the
 * HTML files, and flags duplicate DOM ids. Catches wiring mistakes before runtime. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const PAIRS = [
  ['public/js/app.js', ['public/index.html']],
  ['public/js/marketscan.js', ['public/marketscan.html']],
  ['public/js/archive.js', ['public/archive.html']],
  ['public/js/common.js', ['public/index.html', 'public/marketscan.html', 'public/archive.html']],
  ['public/js/boot.js', ['public/index.html']],
];

let fails = 0;
function check(cond, msg) { if (!cond) { console.error('  ✘ ' + msg); fails++; } }

for (const [js, htmls] of PAIRS) {
  const src = fs.readFileSync(path.join(ROOT, js), 'utf8');
  const ids = new Set();
  for (const m of src.matchAll(/getElementById\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) ids.add(m[1]);
  for (const h of htmls) {
    const doc = fs.readFileSync(path.join(ROOT, h), 'utf8');
    for (const id of ids) {
      if (id.startsWith('cfg_')) continue; // dynamically generated config fields
      check(new RegExp('id="' + id + '"').test(doc), `${js} uses #${id} but ${h} has no such element`);
    }
  }
}

/* duplicate ids in each document */
for (const h of ['public/index.html', 'public/marketscan.html', 'public/archive.html']) {
  const doc = fs.readFileSync(path.join(ROOT, h), 'utf8');
  const ids = [...doc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  check(dups.length === 0, `${h} duplicate ids: ${dups.join(', ')}`);
}

/* every script src referenced by html must exist */
for (const h of ['public/index.html', 'public/marketscan.html', 'public/archive.html']) {
  const doc = fs.readFileSync(path.join(ROOT, h), 'utf8');
  for (const m of doc.matchAll(/(?:src|href)="(\/[^"?]+?)(\?[^"]*)?"/g)) {
    if (!/\.[a-z0-9]+$/i.test(m[1])) continue; // /marketscan, /archive etc are server routes
    const file = path.join(ROOT, 'public', m[1]);
    check(fs.existsSync(file), `${h} references missing asset ${m[1]}`);
  }
}

/* galaxy button wiring: svg injected by app.js + button exists */
{
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  check(app.includes('GALAXY_SVG'), 'galaxy SVG source missing from app.js');
  check(app.includes('ensureGalaxy'), 'galaxy auto-inject missing from app.js');
  check(idx.includes('power-btn galaxy'), 'power button markup missing galaxy class');
}

console.log(fails ? `UI AUDIT FAILED (${fails})` : 'UI AUDIT PASSED — all ids, assets & wiring verified');
process.exit(fails ? 1 : 0);
