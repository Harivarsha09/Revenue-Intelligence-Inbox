'use strict';
// Full replay contract as a local command:  npm run replay
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
process.env.STATE_FILE = path.join(ROOT, 'state', 'replay-state.json');
const core = require('../lib/core');
const D = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f + '.json'), 'utf8'));
const log = [], say = (ok, m) => { log.push((ok ? 'PASS ' : 'FAIL ') + m); console.log(log[log.length - 1]); };
const m7 = st => core.buildViews(st).find(v => v.ref === 'M07');
const snap = st => { const v = core.buildViews(st), m = core.metrics(v); return { n: v.length, text: m.coverage.n, conn: m.connection.n, assign: m.assignments }; };
fs.rmSync(process.env.STATE_FILE, { force: true });
let st = core.emptyState();

let s = core.importEnvelope(st, D('01_initial')); core.save(st);
assert.strictEqual(s.added, 44); assert.strictEqual(snap(st).text, 17);
say(true, `1 initial import: ${snap(st).n} unique records, ${snap(st).text} usable texts; M07 state = ${m7(st).intake}`);
const base = snap(st);

s = core.importEnvelope(st, D('01_initial'), { shuffle: true });
assert.strictEqual(s.added, 0); assert.strictEqual(s.ignored, 44); assert.deepStrictEqual(snap(st), base);
say(true, `2 repeat import (shuffled order): added ${s.added}, ignored ${s.ignored}; counts unchanged ${JSON.stringify(snap(st))}`);

const key = m7(st).key;
st.overrides[key] = { routes: ['cs', 'internal'], note: 'Four product bugs must also reach product/ops.', at: new Date().toISOString() }; core.save(st);
assert.deepStrictEqual(m7(st).routes, ['cs', 'internal']);
say(true, `3 manual correction on M07: active routes ${m7(st).routes} (suggested was ${m7(st).suggested.routes})`);

s = core.importEnvelope(st, D('02_update')); core.save(st);
assert.strictEqual(s.replaced, 1); assert.strictEqual(snap(st).n, 44); assert.strictEqual(snap(st).text, 18);
assert.strictEqual(m7(st).revision, 2); assert.strictEqual(m7(st).freshness, 'current');
assert.deepStrictEqual(m7(st).routes, ['cs', 'internal']);
say(true, `4 update import: replaced ${s.replacedRefs}; still ${snap(st).n} records; usable texts ${snap(st).text}; M07 rev ${m7(st).revision}, analysis ${m7(st).freshness}, suggested now ${m7(st).suggested.routes}, manual kept ${m7(st).routes}`);

s = core.importEnvelope(st, D('01_initial')); core.save(st);
assert.strictEqual(s.ignored, 44); assert.strictEqual(m7(st).revision, 2); assert.strictEqual(snap(st).text, 18);
say(true, `5 stale revision 1 re-imported after rev 2: ignored ${s.ignored}; M07 still rev ${m7(st).revision} with text`);

st = core.load();   // simulate restart: reload from disk
assert.deepStrictEqual(m7(st).routes, ['cs', 'internal']); assert.strictEqual(snap(st).n, 44);
say(true, `6 restart: state reloaded from disk; M07 manual route ${m7(st).routes} and text intact`);

const others = core.buildViews(st).filter(v => v.ref !== 'M07');
assert.ok(others.every(v => v.revision === 1)); say(true, '7 other 43 source records remain revision 1');

const e1 = core.exportAll(st), e2 = core.exportAll(st);
assert.deepStrictEqual(e1.files, e2.files);
const miss = []; e2.manifest.records.forEach(r => r.output_paths.concat(r.record_file).forEach(p => { if (!fs.existsSync(path.join(e2.dir, p))) miss.push(p); }));
e2.manifest.shared_outputs.forEach(p => { if (!fs.existsSync(path.join(e2.dir, p))) miss.push(p); });
assert.strictEqual(miss.length, 0); assert.strictEqual(e2.manifest.records.length, 44);
const stale = fs.existsSync(path.join(e2.dir, 'routes/review', 'M07__4f304fff__review-item.md'));
assert.ok(!stale);
say(true, `8 export x2: ${e2.files.length} files, identical file list (no duplicate active copies), 44 manifest rows, every listed output exists, obsolete M07 review item removed`);
say(true, `   route assignments ${e2.manifest.route_assignments} vs ${e2.manifest.unique_source_records} unique records (multi-route records counted once per route)`);
fs.writeFileSync(path.join(ROOT, 'docs', 'replay-report.txt'), log.join('\n') + '\n');
fs.rmSync(process.env.STATE_FILE, { force: true });
console.log('\nAll replay checks passed. Export written to exports/current/');
