// scripts/check-ejs.js
'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const VIEWS_DIR = path.join(process.cwd(), 'views');

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ejs')) out.push(p);
  }
  return out;
}

function preview(text, idx, len = 160) {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + len);
  return text.slice(start, end).replace(/\r/g, '');
}

const files = walk(VIEWS_DIR);
let bad = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  // quick detect: show if file contains "<%" but not "%>" after it somewhere
  const openIdx = src.indexOf('<%');
  if (openIdx !== -1 && src.indexOf('%>', openIdx) === -1) {
    bad++;
    console.log('\n❌ UNMATCHED "<%" FOUND (no "%>" after it):', file);
    console.log(preview(src, openIdx));
    continue;
  }

  try {
    ejs.compile(src, { filename: file, compileDebug: true });
  } catch (err) {
    bad++;
    console.log('\n❌ EJS COMPILE ERROR IN:', file);
    console.log(String(err && err.message ? err.message : err));
    // show nearby "<%" if any
    const i = src.indexOf('<%');
    if (i !== -1) console.log('\nNearest "<%" preview:\n' + preview(src, i));
  }
}

if (!bad) {
  console.log('\n✅ All .ejs files compiled successfully.');
} else {
  console.log(`\n⚠️ Found ${bad} EJS problem file(s). Fix them and run again.`);
  process.exitCode = 1;
}
