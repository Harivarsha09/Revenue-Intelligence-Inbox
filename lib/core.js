'use strict';
// Core logic: identity/upsert, derived routing, metrics, export. No dependencies.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state', 'state.json');
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(ROOT, 'exports', 'current');
const ANALYSIS = JSON.parse(fs.readFileSync(path.join(ROOT, 'analysis', 'analysis.json'), 'utf8'));

const ROUTES = {
  deal:     { label: 'Deal next steps',        file: 'next-steps.md',      hint: 'Prospect/customer follow-up with a stated next action' },
  coaching: { label: 'Sales coaching',         file: 'coaching.md',        hint: 'Specific, evidence-backed coaching points' },
  partner:  { label: 'Partner / channel',      file: 'partner-note.md',    hint: 'Referral or channel partner, not a buyer' },
  cs:       { label: 'Customer issues',        file: 'customer-issues.md', hint: 'Existing customer: support, migration, onboarding' },
  internal: { label: 'Internal / vendor note', file: 'internal-note.md',   hint: 'SpendNest is the buyer or the audience (vendor eval, training)' },
  closed:   { label: 'Closed - no follow-up',  file: 'closed-note.md',     hint: 'Contact declined; nothing owed' },
  review:   { label: 'Needs human review',     file: 'review-item.md',     hint: 'Evidence missing, pending or contradictory' },
  log:      { label: 'Log only',               file: null,                 hint: 'Nothing to analyse; kept visible in the intake log' },
};

const keyOf = (t, id) => `${t}|${id}`;
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// ---------- state ----------
const emptyState = () => ({ records: {}, overrides: {}, importLog: [] });
function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return emptyState(); } }
function save(s) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

// ---------- import: upsert by identity + revision ----------
function importEnvelope(state, env, opts = {}) {
  if (!env || !Array.isArray(env.records)) throw new Error('Not a delivery envelope: "records" array missing');
  const recs = env.records.slice();
  if (opts.shuffle) recs.sort(() => Math.random() - 0.5);
  const sum = { batch_id: env.batch_id, revision: env.revision, at: new Date().toISOString(), shuffled: !!opts.shuffle,
    received: recs.length, added: 0, replaced: 0, ignored: 0, replacedRefs: [] };
  for (const r of recs) {
    const rev = Number.isInteger(r.revision) ? r.revision : env.revision;
    const k = keyOf(r.source_type, r.source_id);                    // identity = (source_type, source_id)
    const cur = state.records[k];
    const entry = { key: k, record_ref: r.record_ref, source_type: r.source_type, source_id: r.source_id, revision: rev,
      batch_id: env.batch_id, payload: r.payload, transcript_payload: r.transcript_payload ?? null };
    if (!cur) { state.records[k] = { ...entry, history: [{ batch_id: env.batch_id, revision: rev, action: 'added', at: sum.at }] }; sum.added++; }
    else if (rev > cur.revision) {                                   // newer wins: whole payload replaced, nulls included
      state.records[k] = { ...entry, history: [...cur.history, { batch_id: env.batch_id, revision: rev, action: `replaced rev ${cur.revision} -> ${rev}`, at: sum.at }] };
      sum.replaced++; sum.replacedRefs.push(r.record_ref);
    } else sum.ignored++;                                            // same or older revision: ignored
  }
  sum.totalRecords = Object.keys(state.records).length;
  state.importLog.push(sum);
  return sum;
}

// ---------- derived fields (never stored) ----------
function textOf(rec) {
  const p = rec.payload;
  if (rec.source_type === 'call') { const t = (p.transcript || '').trim(); return { usable: !!t, text: t, turns: null }; }
  const turns = ((rec.transcript_payload && rec.transcript_payload.turns) || []).filter(t => (t.text || '').trim());
  return { usable: turns.length > 0, text: turns.map(t => t.text).join('\n'), turns };
}
function ist(ts) {
  const iso = new Date(new Date(ts).getTime() + 330 * 60000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), hour: iso.slice(11, 13) };
}
const company = t => t.replace(/SpendNest|discussion|<>|\//g, '').replace(/\s+-\s+Migration.*/, '').trim();
const counterparty = p => p.direction === 'inbound' ? p.from_number : p.to_number;

function buildViews(state) {
  const recs = Object.values(state.records);
  const byNum = {};                                                  // text-less calls sharing one counterparty token
  recs.filter(r => r.source_type === 'call' && !textOf(r).usable).forEach(r => { const n = counterparty(r.payload); if (n) (byNum[n] = byNum[n] || []).push(r.key); });
  const clusters = Object.fromEntries(Object.entries(byNum).filter(([, v]) => v.length >= 3));
  const byCo = {};
  recs.filter(r => r.source_type === 'meeting').forEach(r => { const c = company(r.payload.title); (byCo[c] = byCo[c] || []).push(r.record_ref); });

  return recs.map(r => {
    const p = r.payload, tx = textOf(r), a = ANALYSIS.records[r.key];
    const fresh = !!(a && tx.usable && a.text_sha === sha(tx.text));
    const when = ist(p.started_at || p.starts_at), flags = [];
    let sug, st;
    if (tx.usable) {
      if (fresh) { sug = { routes: a.routes, reason: a.why, by: 'pre-generated analysis (current)' }; st = 'analysed'; }
      else { sug = { routes: ['review'], reason: a ? 'Source text changed since the analysis was written: analysis is stale.' : 'Text supplied but no analysis prepared yet.', by: 'rule' }; st = 'analysis_pending'; if (a) flags.push('stale'); }
    } else if (r.source_type === 'call') {
      const n = counterparty(p), cl = clusters[n];
      if (cl) { sug = { routes: ['review'], reason: `${cl.length} text-less calls share counterparty ${n} within minutes: possible missed-connection loop. The source label (${p.observed_outcome}) is not evidence of what happened.`, by: 'rule: repeated counterparty' }; st = 'needs_review'; flags.push('cluster'); }
      else if (p.is_connected === true) { sug = { routes: ['review'], reason: 'Source says connected but no text was supplied; cannot tell what was said.', by: 'rule: connected without text' }; st = 'needs_review'; flags.push('conn_no_text'); }
      else { sug = { routes: ['log'], reason: `Source-labelled ${p.observed_outcome}; no text to analyse.`, by: 'rule: no text, not connected' }; st = 'logged_no_text'; }
    } else {
      const why = (r.transcript_payload && r.transcript_payload.unavailable_reason) || p.recording_detail || 'No usable text.';
      sug = { routes: ['review'], reason: why + ' Absence of text does not show the meeting did not happen.', by: 'rule: meeting without text' };
      st = /later/i.test(why) ? 'awaiting_transcript' : 'needs_review';
    }
    const ov = state.overrides[r.key];
    if (ov) flags.push('override');
    if (fresh && a.label && a.label.verdict !== 'supported') flags.push('label_challenged');
    if (r.source_type === 'meeting' && byCo[company(p.title)].length > 1) flags.push('related');
    const person = r.source_type === 'call'
      ? { id: 'rep:' + p.rep_email, label: p.rep_name, role: 'Call rep' }
      : { id: 'org:' + p.organizer_email, label: (p.organizer_email || '').split('@')[0], role: 'Meeting organiser' };
    return { key: r.key, ref: r.record_ref, type: r.source_type, source_id: r.source_id, revision: r.revision, batch_id: r.batch_id,
      title: r.source_type === 'meeting' ? p.title : `${p.direction} call - ${p.observed_outcome}`, person, date: when.date, time: when.time, hour: when.hour,
      usableText: tx.usable, intake: st, suggested: sug, manual: ov || null, routes: ov ? ov.routes : sug.routes,
      freshness: !a ? (tx.usable ? 'no analysis' : 'n/a (no text)') : fresh ? 'current' : 'stale', analysisRev: a ? a.source_revision : null,
      flags, connected: r.source_type === 'call' ? p.is_connected : undefined, isConversation: r.source_type === 'call' ? p.is_conversation : undefined,
      substantive: fresh ? a.substantive : undefined, labelStored: r.source_type === 'call' ? p.observed_outcome : undefined,
      related: r.source_type === 'meeting' ? byCo[company(p.title)].filter(x => x !== r.record_ref) : [], hasAnalysis: fresh };
  }).sort((x, y) => (y.date + y.time).localeCompare(x.date + x.time));
}

function fullView(state, key) {
  const v = buildViews(state).find(x => x.key === key); if (!v) return null;
  const rec = state.records[key], tx = textOf(rec), a = v.hasAnalysis ? ANALYSIS.records[key] : null;
  const verify = ref => ref.t ? !!(tx.turns && tx.turns[ref.t - 1]) : ref.q ? tx.text.includes(ref.q) : null;   // evidence must exist in the text
  const addV = l => (l || []).map(x => ({ ...x, ok: verify(x) }));
  return { ...v, payload: rec.payload, transcript_payload: rec.transcript_payload, history: rec.history,
    turns: tx.turns, text: rec.source_type === 'call' ? tx.text : null,
    analysis: a && { ...a, ev: addV(a.ev), next: addV(a.next), coach: addV(a.coach) } };
}

// ---------- metrics (filterable) ----------
function metrics(views, f = {}) {
  const v = views.filter(x => (!f.type || f.type === 'all' || x.type === f.type) && (!f.person || f.person === 'all' || x.person.id === f.person));
  const calls = v.filter(x => x.type === 'call'), meets = v.filter(x => x.type === 'meeting');
  const pct = (n, d) => d ? Math.round(n / d * 1000) / 10 : null;
  const people = {};
  v.forEach(x => {
    const p = people[x.person.id] = people[x.person.id] || { id: x.person.id, label: x.person.label, role: x.person.role, records: 0, withText: 0, connected: 0, attention: 0 };
    p.records++; if (x.usableText) p.withText++; if (x.connected === true) p.connected++;
    if (['needs_review', 'awaiting_transcript', 'analysis_pending'].includes(x.intake)) p.attention++;
  });
  const routeUnique = {}; let assignments = 0;
  v.forEach(x => x.routes.forEach(r => { routeUnique[r] = (routeUnique[r] || 0) + 1; assignments++; }));
  const hours = {}; v.forEach(x => hours[x.hour] = (hours[x.hour] || 0) + 1);
  const known = calls.filter(x => x.connected === true || x.connected === false), tc = calls.filter(x => x.hasAnalysis);
  const intake = {}; v.forEach(x => intake[x.intake] = (intake[x.intake] || 0) + 1);
  return {
    filter: f, selected: v.length, calls: calls.length, meetings: meets.length, date: v[0] ? v[0].date : null,
    coverage: { n: v.filter(x => x.usableText).length, d: v.length, pct: pct(v.filter(x => x.usableText).length, v.length),
      calls: { n: calls.filter(x => x.usableText).length, d: calls.length }, meetings: { n: meets.filter(x => x.usableText).length, d: meets.length } },
    connection: { n: known.filter(x => x.connected).length, d: known.length, unknown: calls.length - known.length, pct: pct(known.filter(x => x.connected).length, known.length) },
    substantive: { n: tc.filter(x => x.substantive).length, d: tc.length, sourceSays: tc.filter(x => x.isConversation === true).length },
    people: Object.values(people).sort((a, b) => (a.role === b.role ? 0 : a.role === 'Call rep' ? -1 : 1) || b.records - a.records), routeUnique, assignments,
    manualOverrides: v.filter(x => x.manual).length, labelsChallenged: v.filter(x => x.flags.includes('label_challenged')).length,
    stale: v.filter(x => x.flags.includes('stale')).length, intake, hours,
  };
}

// ---------- export ----------
function md(v, route, a) {
  const R = ROUTES[route], L = [], id8 = v.source_id.slice(0, 8);
  const other = v.routes.filter(r => r !== route).map(r => ROUTES[r].file ? `${r}: ../${r}/${v.ref}__${id8}__${ROUTES[r].file}` : r);
  L.push(`# ${R.label} - ${v.ref}: ${v.title}`, '',
    `- Source: ${v.type} \`${v.source_id}\` | applied revision ${v.revision} | ${v.date} ${v.time} IST`,
    `- Route: ${route}${v.manual ? ' (MANUAL; suggested was ' + v.suggested.routes.join('+') + ')' : ' (suggested)'}`,
    `- Also routed to: ${other.length ? other.join(', ') : 'none'}`,
    `- Intake state: ${v.intake} | analysis freshness: ${v.freshness}`,
    `- Source record: ../../records/${v.ref}__${id8}.json`, '');
  if (v.manual) L.push(`> Manual decision${v.manual.note ? ': ' + v.manual.note : ''}`, '');
  if (route === 'review') { L.push('## Why this needs a person', v.suggested.reason, '', '## Needed', '- Decide whether this needs a transcript, analysis, or can be closed.'); return L.join('\n'); }
  if (!a) { L.push('No current analysis is available for this record (no usable text, or text changed since analysis).'); return L.join('\n'); }
  const rs = x => x.t ? `turn ${x.t}` : x.q ? `"${x.q}"` : 'n/a';
  L.push('## What happened', a.what, '');
  if (route === 'coaching') { L.push('## Coaching points'); (a.coach || []).forEach(c => L.push(`- ${c.c} (${rs(c)})`)); if (!(a.coach || []).length) L.push('- None prepared for this record.'); }
  else {
    L.push('## Evidence'); (a.ev || []).forEach(e => L.push(`- ${e.say} (${rs(e)})`));
    L.push('', '## Next steps (owner shown only where the text states one)'); (a.next || []).forEach(n => L.push(`- ${n.do} | owner: ${n.owner} | ${rs(n)}`));
  }
  L.push('', '## Not established'); (a.notEstablished || []).forEach(n => L.push(`- ${n}`));
  if (a.label && route !== 'coaching') L.push('', '## Source label check', `- stored: ${a.label.stored} -> ${a.label.verdict}: ${a.label.why}`);
  return L.join('\n');
}
const csv = rows => rows.map(r => r.map(c => { c = c == null ? '' : String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',')).join('\n');

function briefMd(views, m) {
  const B = ANALYSIS.brief, byRef = Object.fromEntries(views.map(v => [v.ref, v]));
  const pend = it => (it.needs || []).some(r => !byRef[r] || !byRef[r].hasAnalysis);
  const rs = e => e.t ? `${e.ref} turn ${e.t}` : `${e.ref} "${e.q}"`;
  const L = [`# ${B.title}`, '', '_Pre-generated analysis; the activity line is computed live. Scope: selected records only, not a whole-team day._', '',
    `**Activity (live):** ${m.selected} selected records (${m.calls} calls, ${m.meetings} meetings); usable text ${m.coverage.n}/${m.coverage.d}; source-reported connected ${m.connection.n}/${m.connection.d} calls.`, ''];
  for (const [h, k] of [['Important conversations', 'important'], ['Follow-up priorities (ranked)', 'followups'], ['Practical coaching', 'coaching'], ['Data cautions', 'cautions']]) {
    L.push(`## ${h}`); B[k].forEach((it, i) => L.push(`${i + 1}. ${pend(it) ? '[PENDING UPDATE - source text not yet imported] ' : ''}${it.text}${it.ev ? ' (' + it.ev.map(rs).join('; ') + ')' : ''}`)); L.push('');
  }
  return L.join('\n');
}

function exportAll(state, dir = EXPORT_DIR) {
  fs.rmSync(dir, { recursive: true, force: true });                  // regenerate cleanly: no obsolete active copies
  const files = {}, put = (rel, txt) => { files[rel] = txt; };
  const views = buildViews(state), m = metrics(views), manifest = [], logRows = [['ref', 'source_type', 'source_id', 'who', 'time_ist', 'source_label', 'reason']];
  for (const v of views.slice().sort((a, b) => a.ref.localeCompare(b.ref))) {
    const fv = fullView(state, v.key), a = fv.analysis, outs = [], id8 = v.source_id.slice(0, 8);
    for (const r of v.routes) {
      if (r === 'log') { outs.push('routes/log/intake-log.csv'); logRows.push([v.ref, v.type, v.source_id, v.person.label, v.time, v.labelStored || '', v.suggested.reason]); }
      else { const rel = `routes/${r}/${v.ref}__${id8}__${ROUTES[r].file}`; outs.push(rel); put(rel, md(v, r, a)); }
    }
    const recRel = `records/${v.ref}__${id8}.json`;
    put(recRel, JSON.stringify({ source_type: v.type, source_id: v.source_id, applied_revision: v.revision, batch_id: v.batch_id, suggested_routes: v.suggested.routes,
      suggested_by: v.suggested.by, active_routes: v.routes, manual_override: v.manual, intake_state: v.intake, analysis_freshness: v.freshness, outputs: outs,
      proposed_related_records_title_match_only: v.related, source_payload: fv.payload, source_transcript_payload: fv.transcript_payload }, null, 1));
    manifest.push({ record_ref: v.ref, source_type: v.type, source_id: v.source_id, applied_source_revision: v.revision, local_date: v.date, who: v.person.label, who_role: v.person.role,
      suggested_routes: v.suggested.routes, active_routes: v.routes, manual_override: !!v.manual, manual_note: v.manual ? v.manual.note || '' : '',
      processing_review_state: v.intake, analysis_freshness: v.freshness, analysis_based_on_revision: v.analysisRev, output_paths: [...new Set(outs)], record_file: recRel, flags: v.flags });
  }
  if (logRows.length > 1) put('routes/log/intake-log.csv', csv(logRows));
  const bp = `daily/${m.date}/`;
  put(bp + 'manager-brief.md', briefMd(views, m));
  put(bp + 'activity-by-person.csv', csv([['person', 'role', 'selected_records', 'with_usable_text', 'source_reported_connected'], ...m.people.map(p => [p.label, p.role, p.records, p.withText, p.connected])]));
  put('README.txt', ['Revenue Intelligence Inbox - export (derived from app state; regenerated on every export)', '',
    'manifest.json / manifest.csv      one row per source record (identity = source_type + source_id)',
    'records/<ref>__<id8>.json         full context per record: source payload, routes, override, outputs',
    'routes/<route>/<ref>__<id8>__<kind>.md   one file per ACTIVE route; a record with 2 routes has 2 files that link to each other',
    'routes/log/intake-log.csv         shared log for text-less records routed to "log"',
    'daily/<date>/                     shared outputs that reference many records',
    'Obsolete routes disappear on re-export; the manifest keeps suggested_routes next to active_routes.'].join('\n'));
  const meta = { generated_at: new Date().toISOString(), unique_source_records: views.length, route_assignments: m.assignments, usable_text: m.coverage.n,
    shared_outputs: [bp + 'manager-brief.md', bp + 'activity-by-person.csv'], records: manifest };
  put('manifest.json', JSON.stringify(meta, null, 1));
  put('manifest.csv', csv([['record_ref', 'source_type', 'source_id', 'applied_source_revision', 'suggested_routes', 'active_routes', 'manual_override', 'processing_review_state', 'analysis_freshness', 'output_paths'],
    ...manifest.map(r => [r.record_ref, r.source_type, r.source_id, r.applied_source_revision, r.suggested_routes.join(';'), r.active_routes.join(';'), r.manual_override, r.processing_review_state, r.analysis_freshness, r.output_paths.join(';')])]));
  for (const [rel, txt] of Object.entries(files)) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); }
  return { dir, files: Object.keys(files).sort(), manifest: meta };
}

// ---------- store-only ZIP writer (no dependency) ----------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipDir(dir) {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const parts = [], central = []; let off = 0, count = 0;
  for (const f of walk(dir)) {
    const name = Buffer.from(path.relative(dir, f).split(path.sep).join('/')), data = fs.readFileSync(f), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, data); central.push(c, name); off += 30 + name.length + data.length; count++;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

module.exports = { ROUTES, ANALYSIS, ROOT, STATE_FILE, EXPORT_DIR, emptyState, load, save, importEnvelope, buildViews, fullView, metrics, exportAll, zipDir, keyOf, sha, textOf };
