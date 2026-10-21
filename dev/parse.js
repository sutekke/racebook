/* Parse racing.com form pages (desktop layout) from their visible text.
   Input is what the browser shows: document.title and document.body.innerText.
   Works in Node and in a browser (it attaches RBParse to the page when loaded there). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RBParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const lines = text => String(text || '').split('\n')
    .map(s => s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const money = s => {
    if (!s || /^[–-]$/.test(s)) return null;
    const n = parseFloat(String(s).replace(/[$,]/g, ''));
    return isNaN(n) ? null : n;
  };
  /* finishing-position tokens on results pages */
  const POS = /^((\d+)(st|nd|rd|th)(=)?|SCR|LSCR|F|FF|FELL|DNF|LR|DQ|PU|BD|RO|NP)$/i;
  /* values that follow a runner on results pages: weight, prize, settled, margin/time, SP, tote */
  const VAL = /kg$|^\$|^[–-]$|^\d+(\.\d+)?L$|^\d+(st|nd|rd|th)\/\d+(st|nd|rd|th)$|^\d+:\d\d\.\d\d$|^\d\d\.\d\d$/;
  const RUNNER = /^(\d+)\.\s+(.*?)(?:\s*\((\d+)\))?$/;
  const norm = s => String(s || '').toLowerCase().replace(/\([a-z]{2,3}\)/g, '').replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  const lev = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };

  /* Stewards flags for a runner: our own short labels, never the report's wording. */
  const RULES = [
    [/slow to begin|slow into stride|lost ground at the start|missed the start|began very slowly/i, 'Slow start'],
    [/began awkwardly|knuckled|stumbled|blundered|bumped at the start|jumped (in|out)/i, 'Awkward start'],
    [/held up|disappointed for a run|unable to obtain clear running|did not secure clear running|not able to be ridden out|denied clear running/i, 'Held up'],
    [/wide without cover|four wide|five wide/i, 'Wide, no cover'],
    [/raced keenly|over ?raced|pulled hard|ungenerously|fractious/i, 'Raced keenly'],
    [/hampered|crowded|checked|steadied|restricted room|carried (out|wide)|made contact|raced tight|brushed|bumped (with|by|on)|awkwardly placed/i, 'Interference'],
    [/laid (in|out)|laying (in|out)|hung (in|out)|hanging (in|out)|lugged/i, 'Laid/hung'],
    [/change of tactics|restrained after the start|ridden further back|ridden (more )?positively/i, 'Tactics'],
    [/no explanation|failed to (run on|finish|quicken)|disappoint(ing|ment)|raced (a little )?flat|failed to run out|did not finish the race off/i, 'Below expectations'],
    [/slower than expected recovery|lame|laceration|abrasion|sore |cardiac|irregular heart|heat stress|injur/i, 'Vet: issue'],
    [/haemorrhage|bled /i, 'Bled'],
    [/veterinary clearance is required|required to trial|must trial/i, 'Clearance needed'],
    [/\bfell\b|falling|was brought down|lost (its|his|her) rider|dislodged/i, 'Fell / brought down'],
    [/euthanas|humanely destroyed|fatal(ly)? injur/i, 'Fatal injury'],
    [/spelled|end of (its|her|his) preparation/i, 'To be spelled'],
    [/fined|reprimanded|suspended|pleaded guilty|charged/i, 'Penalty/fine'],
    [/re-plated|re-shod|plate|shoes|gear/i, 'Gear/plates'],
    [/not suited by the (shifting )?(track|surface|going|conditions)|heavy track|track conditions/i, 'Track not suited'],
    [/better suited .*distance|greater distance|shorter distance/i, 'Distance query'],
    [/late scratching|was scratched (at|on|by)|withdrawn/i, 'Late scratching'],
    [/did not identify any significant abnormal/i, 'Vet: clear'],
    [/pre-race veterinary examination|veterinary examination and was passed/i, 'Pre-race vet']
  ];
  /* Race-level flags from report paragraphs that don't name a runner. */
  const RACE_RULES = [
    [/start (of (the|this) race )?was delayed|delayed (the )?start|start was delayed/i, 'Start delayed'],
    [/false start|race was re-?started/i, 'False start'],
    [/inquiry|enquiry/i, 'Inquiry'],
    [/protest/i, 'Protest'],
    [/\bfell\b|falling|brought down|dislodged/i, 'Fall'],
    [/hospital|ambulance|concussion/i, 'Rider hurt'],
    [/euthanas|humanely destroyed|fatal/i, 'Horse fatality'],
    [/abandon/i, 'Abandoned'],
    [/track (rating )?(was )?(upgraded|downgraded)|rating (was )?(changed|upgraded|downgraded)/i, 'Rating change'],
    [/dead heat/i, 'Dead heat'],
    [/barrier (malfunction|failure)|gates? (failed|malfunctioned)/i, 'Barrier fault']
  ];
  const tagsFor = (t, rules) => {
    const out = [];
    (rules || RULES).forEach(([re, tag]) => { if (re.test(t) && !out.includes(tag)) out.push(tag); });
    if (out.includes('Vet: issue')) {
      const i = out.indexOf('Vet: clear');
      if (i >= 0 && !/did not identify any significant abnormal findings\.?$/i.test(t)) out.splice(i, 1);
    }
    return out;
  };

  /** Parse a race page. path like /form/2026-10-24/flemington/race/3 */
  function parsePage(title, text, path) {
    title = String(title || '');
    if (/RDC 404|NotFound/i.test(title)) return { kind: '404' };
    const tp = title.split('|').map(s => s.trim());
    if (tp[0] !== 'Form' || !/^Race \d+$/i.test(tp[3] || '')) return { kind: 'unknown', title: title.slice(0, 80) };
    const seg = String(path || '').split('?')[0].split('/').filter(Boolean);
    const L = lines(text);
    const idx = (re, from = 0, to = L.length) => { for (let i = from; i < Math.min(to, L.length); i++) if (re.test(L[i])) return i; return -1; };
    const o = { date: seg[1], slug: seg[2], n: parseInt(seg[4], 10) || parseInt(tp[3].replace(/\D/g, ''), 10), trk: tp[2] || seg[2], st: tp[6] || '', pg: tp[1] || '' };

    const ir = idx(/^(Firm|Good|Soft|Heavy|Synthetic)(\s+\d+)?$/i, 0, 80); o.rt = ir >= 0 ? L[ir] : null;
    const iw = idx(/^-?\d+(\.\d+)?°C$/, 0, 80); o.wx = iw >= 0 ? L[iw] : null;
    const il = idx(/^Track Rail$/, 0, 80); o.rail = il >= 0 ? L[il + 1] : null;
    let stageText = il >= 0 ? (L[il + 2] || '') : '';
    if (!/result|abandon|postpone/i.test(stageText)) {
      const is = idx(/^(Final Results?|Interim Results?|Results?|Abandoned|Postponed)$/i, 0, 60);
      if (is >= 0) stageText = L[is];
    }
    o.stageText = stageText;
    o.stage = /abandon|postpone/i.test(stageText) ? 'abandoned' : /interim/i.test(stageText) ? 'interim' : /result/i.test(stageText) ? 'final' : 'field';
    const cd = stageText.match(/^(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?$/);
    if (o.stage === 'field' && cd && (cd[1] || cd[2] || cd[3])) o.countdown = (+cd[1] || 0) * 1440 + (+cd[2] || 0) * 60 + (+cd[3] || 0);

    const ia = idx(/^All$/, 0, 120);
    let k = ia + 1; while (ia >= 0 && k < L.length && /^\d+$/.test(L[k])) k++;
    o.rc = ia >= 0 ? k - ia - 1 : null;
    if (ia >= 0) {
      o.nm = L[k] || null;
      let t = k + 1; if (!/^\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?$/i.test(L[t] || '')) { const f = idx(/^\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?$/i, k, k + 4); if (f >= 0) t = f; }
      o.tm = /^\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?$/i.test(L[t] || '') ? L[t] : null;
      const di = idx(/^\d{3,4}m$/, t, t + 3);
      o.dist = di >= 0 ? parseInt(L[di], 10) : null;
      const cond = di >= 0 ? (L[di + 1] || '') : '';
      o.cond = cond.split('. Track name')[0].slice(0, 170);
      const cm = cond.match(/(Group \d|Listed|BenchMark \d+|Benchmark \d+|Maiden|Class \d|Rating \d+|Open)/i);
      o.cls = cm ? cm[1].replace('BenchMark', 'Benchmark') : null;
    }
    const val = lb => { const i = idx(new RegExp('^' + lb + ':?$')); return i >= 0 ? L[i + 1] : null; };
    o.time = val('Race Time');
    if (o.time && !/^\d+:\d\d\.\d\d$|^\d\d\.\d\d$/.test(o.time)) o.time = null;
    const it = idx(/^Race Time:?$/);
    o.vs = (it >= 0 && /^[+-]?\d+(\.\d+)?L$/.test(L[it + 2] || '')) ? L[it + 2] : null;
    o.prize = parseInt((val('Prize Money') || '').replace(/\D/g, ''), 10) || null;

    const rn = [];
    const ih = idx(/^ONE POOL$/);
    if (ih >= 0) {
      /* results table */
      let i = ih + 1;
      while (i < L.length) {
        if (!POS.test(L[i])) { i++; continue; }
        const pt = L[i]; const m = (L[i + 1] || '').match(RUNNER);
        if (!m) { i++; continue; }
        const r = { p: /^\d/.test(pt) ? parseInt(pt, 10) : null, pt: pt.toUpperCase(), no: parseInt(m[1], 10), h: m[2].trim(), b: m[3] ? parseInt(m[3], 10) : null };
        let j = i + 2;
        if (/^T:?$/.test(L[j])) { r.tr = L[j + 1]; j += 2; }
        if (/^J:?$/.test(L[j])) { r.j = L[j + 1]; j += 2; }
        const v = []; while (j < L.length && !POS.test(L[j]) && VAL.test(L[j]) && v.length < 7) { v.push(L[j]); j++; }
        r.w = parseFloat((v.find(x => /kg$/.test(x)) || '').replace(/[^\d.]/g, '')) || null;
        r.s = v.find(x => /^\d+(st|nd|rd|th)\/\d+(st|nd|rd|th)$/.test(x)) || null;
        r.m = v.find(x => /^\d+(\.\d+)?L$/.test(x)) || null;
        const last3 = v.slice(-3);
        r.sp = v.length >= 4 ? money(last3[0]) : null;
        r.tw = v.length >= 4 ? money(last3[1]) : null;
        r.tp = v.length >= 4 ? money(last3[2]) : null;
        if (/SCR/i.test(pt)) { r.sp = r.tw = r.tp = null; r.pt = 'SCR'; }
        r.tg = [];
        rn.push(r); i = j;
      }
    } else {
      /* field: each runner block runs from "N. Name (barrier)" + "T:" to the next one */
      const starts = [];
      for (let i = 0; i < L.length - 1; i++) if (RUNNER.test(L[i]) && /^T:?$/.test(L[i + 1])) starts.push(i);
      starts.forEach((s, bi) => {
        const B = L.slice(s, bi + 1 < starts.length ? starts[bi + 1] : Math.min(L.length, s + 60));
        const m = B[0].match(RUNNER);
        const r = { p: null, pt: '', no: parseInt(m[1], 10), h: m[2].trim(), b: m[3] ? parseInt(m[3], 10) : null, tg: [] };
        let j = 1;
        if (/^T:?$/.test(B[j])) { r.tr = B[j + 1]; j += 2; }
        if (/^J:?$/.test(B[j])) { r.j = B[j + 1]; j += 2; }
        const kg = B.findIndex((x, q) => q >= j && /^\d+(\.\d+)?kg$/.test(x));
        if (kg >= 0) {
          r.w = parseFloat(B[kg]);
          const pre = B.slice(j, kg);
          const ci = pre.findIndex(x => /^\d+: \d+-\d+-\d+$/.test(x) || /^: ?--$/.test(x));
          if (ci >= 0) { r.cr = /^:/.test(pre[ci]) ? null : pre[ci]; if (ci > 0) r.fm = pre[ci - 1]; }
          else if (pre.length) r.fm = pre[0];
          if (r.fm === 'First Start') r.fm = 'First starter';
          const gc = B[kg + 1], rtg = B[kg + 2];
          if (gc && !/^[–-]$/.test(gc) && !/^\d+%?$/.test(gc) && !/^[WP]$/.test(gc) && gc !== 'FAVOURITE' && gc !== 'FULL FORM') r.gc = gc.slice(0, 60);
          if (/^\d{1,3}$/.test(rtg || '')) r.rtg = +rtg;
          if (/^\d+%$/.test(B[kg + 3] || '')) r.wpc = B[kg + 3];
          if (/^\d+%$/.test(B[kg + 4] || '')) r.ppc = B[kg + 4];
          const li = B.findIndex((x, q) => q > kg && /^\d+(st|nd|rd|th)\/\d+\s*\|/.test(x));
          if (li >= 0) r.ls = (B[li] + (B[li + 1] && /\|/.test(B[li + 1]) ? ' · ' + B[li + 1] : '')).replace(/\s*\|\s*/g, ' ');
        }
        if (B.some(x => /^(SCR|LSCR|Scratched)$/i.test(x))) r.pt = 'SCR';
        else if (B.some(x => /^(EM|EMG|Emergency)$/i.test(x))) r.pt = 'EMG';
        if (B.includes('FAVOURITE')) r.fav = true;
        const wi = B.indexOf('W');
        if (wi >= 0 && r.pt !== 'SCR') {
          const w = money(B[wi + 1]);
          const pi = B.indexOf('P', wi);
          const p = pi >= 0 ? money(B[pi + 1]) : null;
          if (w) r.od = { w, p, bk: 'racing.com' };
        }
        if (r.j === 'TBC') delete r.j;
        rn.push(r);
      });
    }
    o.rn = rn.map(r => { if (r.p != null) delete r.pt; Object.keys(r).forEach(x => (r[x] === null || r[x] === undefined || r[x] === '') && delete r[x]); return r; });
    Object.keys(o).forEach(x => (o[x] === null || o[x] === undefined) && delete o[x]);
    return { kind: 'race', race: o };
  }

  /** Stewards report paragraphs, or null when the report isn't published yet. */
  function parseStewards(text) {
    const L = lines(text);
    const a = L.indexOf('News & Video');
    const b = L.findIndex(l => /^FULL STEWARDS/i.test(l));
    if (a < 0 || b <= a) return null;
    return L.slice(a + 1, b).filter(p => p.length >= 25 || (p.length >= 12 && /[.:]/.test(p)));
  }

  /** Put flags on a race's runners from report paragraphs. Returns {n, general, sf}. Stores no report text. */
  function applyStewards(race, paras) {
    const names = (race.rn || []).map(r => ({ r, n: norm(r.h) })).sort((x, y) => y.n.length - x.n.length);
    (race.rn || []).forEach(r => { r.tg = []; });
    const sf = [];
    let general = 0;
    paras.forEach(p => {
      const np = norm(p);
      let hit = names.find(x => x.n && (np.startsWith(x.n + ' ') || np === x.n));
      if (!hit) {
        const fw = np.split(' ').slice(0, 2).join(' ');
        hit = names.find(x => x.n.split(' ').slice(0, 2).join(' ') === fw && fw.length >= 5)
          || names.find(x => { const a1 = x.n.split(' ')[0], b1 = np.split(' ')[0]; return a1.length >= 6 && lev(a1, b1) <= 2; });
      }
      if (hit) tagsFor(p).forEach(t => { if (!hit.r.tg.includes(t)) hit.r.tg.push(t); });
      else { general++; tagsFor(p, RACE_RULES).forEach(t => { if (!sf.includes(t)) sf.push(t); }); }
    });
    (race.rn || []).forEach(r => { if (!r.tg.length) delete r.tg; });
    return { n: paras.length, general, sf };
  }

  return { lines, money, norm, hkeyLike: norm, tagsFor, RULES, RACE_RULES, parsePage, parseStewards, applyStewards };
});
