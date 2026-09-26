'use strict';
/* JSON persistence with atomic writes (data/ directory, gitignored). */
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) { return path.join(DATA_DIR, name + '.json'); }

function load(name, fallback) {
  try {
    if (fs.existsSync(file(name))) return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) { /* corrupted -> backup & recreate */
    try { fs.renameSync(file(name), file(name) + '.corrupt.' + Date.now()); } catch (e2) {}
  }
  return fallback;
}

const pending = new Map();
let saveTimer = null;

function save(name, obj, immediate) {
  pending.set(name, obj);
  if (immediate) { flushOne(name); return; }
  if (!saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = null; flushAll(); }, 2500);
  }
}

function flushOne(name) {
  const obj = pending.get(name);
  if (obj === undefined) return;
  try {
    const tmp = file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file(name));
    pending.delete(name);
  } catch (e) { /* retry next flush */ }
}
function flushAll() { for (const n of Array.from(pending.keys())) flushOne(n); }

setInterval(flushAll, 5000).unref();

module.exports = { load, save, DATA_DIR };
