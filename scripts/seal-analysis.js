'use strict';
// Binds each pre-generated analysis to the exact source text it was written from (sha of text + revision),
// and verifies every evidence quote/turn exists. Run after editing analysis/analysis.src.json:  npm run seal
const fs = require('fs'), path = require('path');
process.env.STATE_FILE = path.join(__dirname, '..', 'state', '_seal.json');
const core = require('../lib/core');
const R = path.join(__dirname, '..');
const st = core.emptyState();
['01_initial', '02_update'].forEach(f => core.importEnvelope(st, JSON.parse(fs.readFileSync(path.join(R, 'data', f + '.json'), 'utf8'))));
const src = JSON.parse(fs.readFileSync(path.join(R, 'analysis', 'analysis.src.json'), 'utf8'));
const byRef = Object.fromEntries(Object.values(st.records).map(r => [r.record_ref, r]));
const out = { sealed_at: new Date().toISOString(), records: {}, brief: src.brief }; let bad = 0;
const check = (ref, x) => {
  const r = byRef[ref], tx = core.textOf(r);
  const ok = x.t ? !!(tx.turns && tx.turns[x.t - 1]) : x.q ? tx.text.includes(x.q) : true;
  if (!ok) { bad++; console.error('EVIDENCE NOT FOUND', ref, JSON.stringify(x)); }
};
for (const [ref, a] of Object.entries(src.records)) {
  const r = byRef[ref]; if (!r) { console.error('unknown ref', ref); bad++; continue; }
  const tx = core.textOf(r);
  [...(a.ev || []), ...(a.next || []), ...(a.coach || [])].forEach(x => check(ref, x));
  out.records[r.key] = { ref, source_type: r.source_type, source_id: r.source_id, source_revision: r.revision, text_sha: core.sha(tx.text), ...a };
}
['important', 'followups', 'coaching', 'cautions'].forEach(k => src.brief[k].forEach(it => (it.ev || []).forEach(e => check(e.ref, e))));
if (bad) { console.error(bad + ' problem(s)'); process.exit(1); }
fs.writeFileSync(path.join(R, 'analysis', 'analysis.json'), JSON.stringify(out, null, 1));
fs.rmSync(process.env.STATE_FILE, { force: true });
console.log('sealed', Object.keys(out.records).length, 'analyses; all evidence verified');
