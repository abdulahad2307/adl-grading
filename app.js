(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const DEMO = !CFG.SCRIPT_URL;
  const PASS_KEY = 'grading.passphrase';
  const DEMO_KEY = 'grading.demo.v1';

  const state = {
    pass: null,
    sessions: [],
    exercises: [],
    sessionId: null,
    view: null,          // an exercise id, 'overview' or 'list'
    cache: {},           // sessionId -> { exercises: { ex1: [rows] } }
    filter: '',
    draft: {},           // sessionId -> textarea text not yet saved
  };

  const $app = document.getElementById('app');

  /* ---------- small helpers ---------- */

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function session() { return state.sessions.find(s => s.id === state.sessionId); }
  function sessionData() { return state.cache[state.sessionId]; }
  function rowsOf(exId) { const d = sessionData(); return (d && d.exercises[exId]) || []; }
  function roster() {
    for (const ex of state.exercises) { const r = rowsOf(ex.id); if (r.length) return r; }
    return [];
  }
  function groupRows(rows) {
    const out = [];
    rows.forEach(r => {
      const last = out[out.length - 1];
      if (last && String(last.num) === String(r.group)) last.rows.push(r);
      else out.push({ num: r.group, rows: [r] });
    });
    return out;
  }

  let toastTimer;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = h('div', { id: 'toast', role: 'status' }); document.body.append(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
  }

  /* ---------- talking to the sheet ---------- */

  async function api(action, payload = {}) {
    if (DEMO) return demoApi(action, payload);
    let res;
    try {
      // No custom headers: the body goes as text/plain, which Apps Script accepts without a CORS preflight.
      res = await fetch(CFG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ action, passphrase: state.pass, ...payload }),
      });
    } catch {
      const err = new Error('No connection to the Google Sheet.');
      err.network = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`The sheet script answered with HTTP ${res.status}.`);
      err.network = res.status >= 500;
      throw err;
    }
    let j;
    try { j = await res.json(); } catch {
      throw new Error('The sheet script sent back a web page instead of data. Check that the deployment is set to “Anyone” and that config.js has the /exec URL.');
    }
    if (!j.ok) {
      const err = new Error(j.error || 'The sheet script reported an error.');
      err.code = j.code;
      throw err;
    }
    return j;
  }

  /* Demo mode: same behaviour as Code.gs, kept in this browser only. */
  const DEMO_SESSIONS = [
    { id: 'tue-10', label: 'Tuesday 10–12', short: 'Tue 10-12' },
    { id: 'wed-12', label: 'Wednesday 12–14', short: 'Wed 12-14' },
    { id: 'wed-14', label: 'Wednesday 14–16', short: 'Wed 14-16' },
    { id: 'thu-12', label: 'Thursday 12–14', short: 'Thu 12-14' },
    { id: 'thu-14', label: 'Thursday 14–16', short: 'Thu 14-16' },
  ];
  const DEMO_EXERCISES = [
    { id: 'ex1', label: 'Exercise 1', short: 'Ex1' },
    { id: 'ex2', label: 'Exercise 2', short: 'Ex2' },
    { id: 'ex3', label: 'Exercise 3', short: 'Ex3' },
  ];
  async function demoApi(action, p) {
    await sleep(120);
    let db;
    try { db = JSON.parse(store.get(DEMO_KEY)) || {}; } catch { db = {}; }
    const save = () => store.set(DEMO_KEY, JSON.stringify(db));
    if (action === 'config') return { ok: true, sessions: DEMO_SESSIONS, exercises: DEMO_EXERCISES };
    if (action === 'load') {
      const exercises = {};
      DEMO_EXERCISES.forEach(e => { exercises[e.id] = (db[`${p.session}/${e.id}`] || []).map(r => ({ ...r })); });
      return { ok: true, data: { exercises } };
    }
    if (action === 'saveRoster') {
      DEMO_EXERCISES.forEach(e => {
        const key = `${p.session}/${e.id}`;
        const old = new Map((db[key] || []).map(r => [r.idm.toLowerCase(), r]));
        db[key] = [];
        p.groups.forEach(g => g.members.forEach(m => {
          const o = old.get(m.idm.toLowerCase()) || {};
          db[key].push({ group: g.num, name: m.name, idm: m.idm, missing: o.missing || '', result: o.result || '', comment: o.comment || '' });
        }));
      });
      save();
      return { ok: true };
    }
    if (action === 'setCell') {
      const rows = db[`${p.session}/${p.exercise}`] || [];
      const r = rows.find(x => x.idm.toLowerCase() === String(p.idm).toLowerCase());
      if (!r) throw new Error(`No student with idm ${p.idm}.`);
      r[p.field] = p.value;
      save();
      return { ok: true };
    }
    throw new Error('Unknown action');
  }

  /* ---------- save queue ---------- */

  const queue = [];
  let inflight = null;
  let flushing = false;
  let offline = false;
  const keyOf = j => `${j.session}/${j.exercise}/${j.idm}/${j.field}`;

  function enqueue(job) {
    const i = queue.findIndex(q => keyOf(q) === keyOf(job));
    if (i >= 0) queue[i] = job; else queue.push(job);
    renderStatus();
    flush();
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    let delay = 2000;
    while (queue.length) {
      const job = queue.shift();
      inflight = job;
      renderStatus();
      try {
        await api('setCell', job);
        offline = false;
        delay = 2000;
      } catch (e) {
        if (e.network) {
          if (!queue.some(q => keyOf(q) === keyOf(job))) queue.unshift(job);
          inflight = null;
          offline = true;
          renderStatus();
          await sleep(delay);
          delay = Math.min(delay * 2, 30000);
          continue;
        }
        if (e.code === 'auth') {
          queue.unshift(job);
          inflight = null;
          flushing = false;
          lock('The passphrase was not accepted any more. Enter it again to keep saving.');
          return;
        }
        toast(`Not saved for ${job.idm}: ${e.message}`);
      }
      inflight = null;
    }
    flushing = false;
    renderStatus();
  }

  function pending() { return queue.length + (inflight ? 1 : 0); }

  window.addEventListener('beforeunload', e => {
    if (pending()) { e.preventDefault(); e.returnValue = ''; }
  });

  function setValue(exId, row, field, value) {
    row[field] = value;
    enqueue({ session: state.sessionId, exercise: exId, idm: row.idm, field, value });
  }

  /* ---------- routing ---------- */

  function go(sessionId, view) {
    const target = `#${sessionId}/${view}`;
    if (location.hash !== target) location.hash = target;
    else route();
  }

  async function route() {
    const [sid, view] = location.hash.replace(/^#/, '').split('/');
    const s = state.sessions.find(x => x.id === sid) || state.sessions[0];
    const views = state.exercises.map(e => e.id).concat(['overview', 'list']);
    state.sessionId = s.id;
    state.view = views.includes(view) ? view : null;
    state.filter = '';

    if (!state.cache[s.id]) {
      renderShell(h('p', { class: 'quiet' }, `Loading ${s.label}…`));
      try {
        await loadSession(s.id);
      } catch (e) {
        if (e.code === 'auth') return lock('That passphrase was not accepted.');
        return renderShell(h('div', { class: 'problem' },
          h('p', null, `Couldn’t load ${s.label}. ${e.message}`),
          h('button', { class: 'btn', onclick: () => route() }, 'Try again')));
      }
    }
    if (!roster().length) state.view = 'list';
    else if (!state.view) state.view = state.exercises[0].id;
    render();
  }

  async function loadSession(id) {
    const j = await api('load', { session: id });
    state.cache[id] = j.data;
  }

  /* ---------- rendering ---------- */

  function renderStatus() {
    const el = document.getElementById('status');
    if (!el) return;
    const n = pending();
    el.className = 'status';
    if (offline) { el.textContent = `Offline, ${n} change${n === 1 ? '' : 's'} waiting`; el.classList.add('warn'); }
    else if (n) { el.textContent = `Saving ${n}…`; el.classList.add('busy'); }
    else el.textContent = DEMO ? 'Saved in this browser' : 'All saved to the sheet';
  }

  function headerBox() {
    const s = session();
    const exIndex = state.exercises.findIndex(e => e.id === state.view);
    let sheetText = '—';
    if (exIndex >= 0) sheetText = `${exIndex + 1} of ${state.exercises.length}`;
    else if (state.view === 'overview') sheetText = 'Overview';
    else if (state.view === 'list') sheetText = 'Student list';

    return h('header', { class: 'pad-head' },
      h('div', { class: 'field wide' }, h('span', { class: 'k' }, 'Course'),
        h('h1', { class: 'v' }, CFG.TITLE || 'Exercise grading')),
      h('div', { class: 'field' }, h('span', { class: 'k' }, 'Term'), h('span', { class: 'v' }, CFG.TERM || '')),
      h('div', { class: 'field' }, h('span', { class: 'k' }, 'Session'), h('span', { class: 'v' }, s ? s.label : '')),
      h('div', { class: 'field' }, h('span', { class: 'k' }, 'Sheet'), h('span', { class: 'v' }, sheetText)),
      h('div', { class: 'field status-field' }, h('span', { class: 'k' }, 'Sync'),
        h('span', { id: 'status', class: 'status', 'aria-live': 'polite' })),
    );
  }

  function navs() {
    const sessionNav = h('nav', { class: 'sessions', 'aria-label': 'Session' },
      state.sessions.map(s => h('a', {
        href: `#${s.id}/${state.view || ''}`,
        'aria-current': s.id === state.sessionId ? 'page' : null,
      }, s.label)));

    const hasRoster = roster().length > 0;
    const tabs = state.exercises.map(e => ({ id: e.id, label: e.label, disabled: !hasRoster }))
      .concat([{ id: 'overview', label: 'Overview', disabled: !hasRoster }, { id: 'list', label: 'Student list' }]);
    const tabNav = h('nav', { class: 'tabs', 'aria-label': 'Sheet' },
      tabs.map(t => t.disabled
        ? h('span', { class: 'tab off', title: 'Add the student list first' }, t.label)
        : h('a', { class: 'tab', href: `#${state.sessionId}/${t.id}`, 'aria-current': t.id === state.view ? 'page' : null }, t.label)));
    return [sessionNav, tabNav];
  }

  function renderShell(body) {
    $app.replaceChildren(...[
      DEMO ? h('p', { class: 'demo' }, 'Demo mode. Marks stay in this browser until you add the sheet script URL to config.js.') : null,
      headerBox(),
      ...navs(),
      h('main', { id: 'main' }, body),
      h('footer', { class: 'foot' },
        DEMO ? null : h('button', { class: 'link', onclick: () => { store.del(PASS_KEY); location.reload(); } }, 'Lock this computer'),
      ),
    ].filter(Boolean));
    renderStatus();
  }

  function render() {
    let body;
    if (state.view === 'list') body = viewList();
    else if (state.view === 'overview') body = viewOverview();
    else body = viewExercise(state.exercises.find(e => e.id === state.view));
    renderShell(body);
  }

  /* ----- exercise sheet ----- */

  function viewExercise(ex) {
    const rows = rowsOf(ex.id);
    const groups = groupRows(rows);
    const q = state.filter.trim().toLowerCase();
    const visible = q
      ? groups.filter(g => String(g.num) === q || g.rows.some(r => r.name.toLowerCase().includes(q) || r.idm.toLowerCase().includes(q)))
      : groups;

    const tbody = h('tbody');
    visible.forEach(g => {
      g.rows.forEach((r, i) => {
        const tr = h('tr', { class: [i === 0 ? 'g-start' : '', r.missing === 'Yes' ? 'is-missing' : ''].join(' ').trim() });
        if (i === 0) tr.append(h('th', { scope: 'rowgroup', rowspan: g.rows.length, class: 'gnum' }, g.num));
        tr.append(
          h('td', { class: 'name' }, r.name),
          h('td', { class: 'idm' }, r.idm),
          h('td', { class: 'miss' }, h('input', {
            type: 'checkbox', checked: r.missing === 'Yes', 'aria-label': `${r.name} missing`,
            onchange: e => {
              setValue(ex.id, r, 'missing', e.target.checked ? 'Yes' : '');
              tr.classList.toggle('is-missing', e.target.checked);
              updateTally(ex.id);
            },
          })),
          h('td', { class: 'pf' }, markButtons(ex.id, r)),
          h('td', { class: 'comment' }, commentInput(ex.id, r)),
        );
        tbody.append(tr);
      });
    });

    const search = h('input', {
      type: 'search', class: 'find', placeholder: 'Find a name, idm or group', value: state.filter,
      'aria-label': 'Find a student',
      oninput: e => {
        state.filter = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const again = document.querySelector('.find');
        again.focus();
        again.setSelectionRange(pos, pos);
      },
    });

    return h('section', null,
      h('div', { class: 'toolbar' },
        search,
        h('button', { class: 'btn', onclick: reload }, 'Reload from sheet'),
        h('button', { class: 'btn', onclick: () => window.print() }, 'Print'),
      ),
      h('div', { class: 'scroll' },
        h('table', { class: 'sheet' },
          h('caption', { class: 'sr' }, `${session().label}, ${ex.label}`),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', class: 'gnum' }, 'Group'),
            h('th', { scope: 'col' }, 'Name'),
            h('th', { scope: 'col' }, 'idm'),
            h('th', { scope: 'col', class: 'miss' }, 'Missing'),
            h('th', { scope: 'col' }, 'Pass/Fail'),
            h('th', { scope: 'col' }, 'Comment'))),
          tbody)),
      !visible.length ? h('p', { class: 'quiet' }, 'Nobody matches that search.') : null,
      h('p', { class: 'tally', id: 'tally' }, tallyText(ex.id)),
    );
  }

  function markButtons(exId, r) {
    const wrap = h('span', { class: 'marks', role: 'group', 'aria-label': `${r.name} result` });
    const make = val => h('button', {
      type: 'button', class: `mark ${val.toLowerCase()}`, 'aria-pressed': r.result === val ? 'true' : 'false',
      onclick: () => {
        const next = r.result === val ? '' : val;
        setValue(exId, r, 'result', next);
        wrap.querySelectorAll('.mark').forEach(b => b.setAttribute('aria-pressed', b.textContent === next ? 'true' : 'false'));
        updateTally(exId);
      },
    }, val);
    wrap.append(make('Pass'), make('Fail'));
    return wrap;
  }

  function commentInput(exId, r) {
    let t;
    const commit = val => { clearTimeout(t); if (val !== r.comment) setValue(exId, r, 'comment', val); };
    return h('input', {
      type: 'text', value: r.comment, maxlength: 500, 'aria-label': `Comment for ${r.name}`,
      oninput: e => { clearTimeout(t); const v = e.target.value; t = setTimeout(() => commit(v), 900); },
      onchange: e => commit(e.target.value),
      onkeydown: e => { if (e.key === 'Enter') e.target.blur(); },
    });
  }

  function tallyText(exId) {
    const rows = rowsOf(exId);
    const pass = rows.filter(r => r.result === 'Pass').length;
    const fail = rows.filter(r => r.result === 'Fail').length;
    const miss = rows.filter(r => r.missing === 'Yes').length;
    return `${pass + fail} of ${rows.length} marked: ${pass} pass, ${fail} fail. ${miss} missing.`;
  }
  function updateTally(exId) { const el = document.getElementById('tally'); if (el) el.textContent = tallyText(exId); }

  async function reload() {
    if (pending()) { toast('Wait until all changes are saved, then reload.'); return; }
    try {
      await loadSession(state.sessionId);
      render();
      toast('Reloaded from the sheet.');
    } catch (e) { toast(`Couldn’t reload: ${e.message}`); }
  }

  /* ----- overview ----- */

  function viewOverview() {
    const base = roster();
    const lookup = {};
    state.exercises.forEach(ex => {
      lookup[ex.id] = new Map(rowsOf(ex.id).map(r => [r.idm.toLowerCase(), r]));
    });

    const tbody = h('tbody');
    groupRows(base).forEach(g => {
      g.rows.forEach((r, i) => {
        const tr = h('tr', { class: i === 0 ? 'g-start' : '' });
        if (i === 0) tr.append(h('th', { scope: 'rowgroup', rowspan: g.rows.length, class: 'gnum' }, g.num));
        tr.append(h('td', { class: 'name' }, r.name), h('td', { class: 'idm' }, r.idm));
        let passed = 0;
        state.exercises.forEach(ex => {
          const x = lookup[ex.id].get(r.idm.toLowerCase());
          let txt = '';
          let cls = 'cell-empty';
          if (x && x.missing === 'Yes') { txt = 'Missing'; cls = 'cell-miss'; }
          else if (x && x.result) { txt = x.result; cls = `cell-${x.result.toLowerCase()}`; }
          if (x && x.result === 'Pass') passed++;
          tr.append(h('td', { class: `ov ${cls}`, title: x && x.comment ? x.comment : null }, txt || '·'));
        });
        tr.append(h('td', { class: 'ov total' }, `${passed}/${state.exercises.length}`));
        tbody.append(tr);
      });
    });

    return h('section', null,
      h('div', { class: 'toolbar' },
        h('p', { class: 'quiet' }, 'Hover a mark to read its comment.'),
        h('button', { class: 'btn', onclick: reload }, 'Reload from sheet'),
        h('button', { class: 'btn', onclick: downloadCsv }, 'Download CSV'),
      ),
      h('div', { class: 'scroll' },
        h('table', { class: 'sheet overview' },
          h('caption', { class: 'sr' }, `${session().label}, overview`),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', class: 'gnum' }, 'Group'),
            h('th', { scope: 'col' }, 'Name'),
            h('th', { scope: 'col' }, 'idm'),
            state.exercises.map(ex => h('th', { scope: 'col', class: 'ov' }, ex.short)),
            h('th', { scope: 'col', class: 'ov' }, 'Passed'))),
          tbody)),
    );
  }

  function downloadCsv() {
    const esc = v => { v = String(v ?? ''); return /[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    const head = ['Group', 'Name', 'idm'];
    state.exercises.forEach(ex => head.push(`${ex.short} result`, `${ex.short} missing`, `${ex.short} comment`));
    const lines = [head];
    roster().forEach(r => {
      const line = [r.group, r.name, r.idm];
      state.exercises.forEach(ex => {
        const x = rowsOf(ex.id).find(y => y.idm.toLowerCase() === r.idm.toLowerCase()) || {};
        line.push(x.result || '', x.missing || '', x.comment || '');
      });
      lines.push(line);
    });
    const csv = '\ufeff' + lines.map(l => l.map(esc).join(',')).join('\r\n');
    const a = h('a', {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
      download: `${session().short.replace(/\s+/g, '_')}_overview.csv`,
    });
    document.body.append(a);
    a.click();
    a.remove();
  }

  /* ----- student list ----- */

  function rosterAsText() {
    return groupRows(roster()).map(g => g.rows.map((r, i) => `${i === 0 ? g.num : ''}\t${r.name}\t${r.idm}`).join('\n')).join('\n');
  }

  function viewList() {
    const s = session();
    const existing = roster();
    const text = state.draft[s.id] ?? rosterAsText();
    const preview = h('div', { class: 'preview' });
    let parsed = null;

    const area = h('textarea', {
      class: 'paste', rows: 14, spellcheck: 'false', value: text,
      'aria-label': `Student list for ${s.label}`,
      placeholder: '1\tAnna Berger\tab12cdef\n\tBen Croft\tcd34efgh\n2\tClara Diaz\tef56ghij\n…',
      oninput: e => { state.draft[s.id] = e.target.value; showPreview(); },
    });

    function showPreview() {
      parsed = RosterParser.parseRoster(area.value);
      const count = parsed.groups.reduce((n, g) => n + g.members.length, 0);
      preview.replaceChildren();
      if (!count) {
        preview.append(h('p', { class: 'quiet' }, 'The groups will show up here as you paste.'));
        return;
      }
      const newIds = new Set(parsed.groups.flatMap(g => g.members.map(m => m.idm.toLowerCase())));
      const removed = existing.filter(r => !newIds.has(r.idm.toLowerCase()));

      preview.append(...[
        h('p', { class: 'summary' }, `${count} students in ${parsed.groups.length} groups.`),
        parsed.errors.length ? h('ul', { class: 'errors' }, parsed.errors.map(x => h('li', null, x))) : null,
        parsed.warnings.length ? h('ul', { class: 'warnings' }, parsed.warnings.map(x => h('li', null, x))) : null,
        removed.length ? h('p', { class: 'warnings' },
          `Saving removes ${removed.length} student${removed.length === 1 ? '' : 's'} and their marks: ${removed.map(r => r.name).join(', ')}.`) : null,
        h('ol', { class: 'groups' }, parsed.groups.map(g =>
          h('li', { value: g.num },
            h('span', { class: 'gl' }, `Group ${g.num}`),
            h('span', null, g.members.map(m => `${m.name || '(no name)'} ${m.idm ? `(${m.idm})` : ''}`.trim()).join(', '))))),
      ].filter(Boolean));
      saveBtn.disabled = parsed.errors.length > 0;
    }

    const saveBtn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!parsed || !parsed.groups.length) return;
        const newIds = new Set(parsed.groups.flatMap(g => g.members.map(m => m.idm.toLowerCase())));
        const removed = existing.filter(r => !newIds.has(r.idm.toLowerCase()));
        if (removed.length && !confirm(`This removes ${removed.length} student(s) and their marks from all ${state.exercises.length} sheets. Continue?`)) return;
        if (pending()) { toast('Wait until all changes are saved first.'); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await api('saveRoster', {
            session: s.id,
            groups: parsed.groups.map(g => ({ num: g.num, members: g.members.map(m => ({ name: m.name, idm: m.idm })) })),
          });
          delete state.draft[s.id];
          await loadSession(s.id);
          toast(`Student list saved to all ${state.exercises.length} sheets of ${s.label}.`);
          go(s.id, state.exercises[0].id);
        } catch (e) {
          if (e.code === 'auth') return lock('That passphrase was not accepted.');
          toast(`Couldn’t save the list: ${e.message}`);
          saveBtn.disabled = false;
          saveBtn.textContent = saveLabel;
        }
      },
    });
    const saveLabel = `Save list to ${state.exercises.map(e => e.short).join(', ')}`;
    saveBtn.textContent = saveLabel;

    const view = h('section', { class: 'list-view' },
      h('div', { class: 'list-intro' },
        h('h2', null, existing.length ? `Student list for ${s.label}` : `Add the students for ${s.label}`),
        h('p', null, 'Paste one student per line with name and idm. Group numbers in the first column, lines like “Group 3”, or blank lines between groups all work. Copying the rows straight out of a spreadsheet is fine.'),
        existing.length ? h('p', { class: 'quiet' }, 'Marks are kept for every student who stays on the list, matched by idm.') : null),
      h('div', { class: 'list-cols' },
        h('div', null, area, h('div', { class: 'actions' }, saveBtn,
          h('button', { class: 'btn', onclick: () => { area.value = ''; state.draft[s.id] = ''; showPreview(); area.focus(); } }, 'Clear'))),
        preview),
    );
    showPreview();
    return view;
  }

  /* ---------- passphrase ---------- */

  function lock(message) {
    store.del(PASS_KEY);
    state.pass = null;
    const input = h('input', { type: 'password', id: 'pp', autocomplete: 'current-password', required: true });
    const msg = h('p', { class: 'problem-text', 'aria-live': 'polite' }, message || '');
    const form = h('form', {
      class: 'gate',
      onsubmit: async e => {
        e.preventDefault();
        state.pass = input.value;
        msg.textContent = 'Checking…';
        try {
          await start();
        } catch (err) {
          state.pass = null;
          msg.textContent = err.code === 'auth' ? 'That passphrase is wrong.' : err.message;
        }
      },
    },
      h('h1', null, CFG.TITLE || 'Exercise grading'),
      h('label', { for: 'pp' }, 'Passphrase'),
      input,
      h('button', { class: 'btn primary', type: 'submit' }, 'Unlock'),
      msg);
    $app.replaceChildren(form);
    input.focus();
  }

  let started = false;
  async function start() {
    const j = await api('config');
    state.sessions = j.sessions;
    state.exercises = j.exercises;
    if (!DEMO) store.set(PASS_KEY, state.pass);
    if (!started) { window.addEventListener('hashchange', route); started = true; }
    await route();
    if (queue.length) flush();
  }

  (async function boot() {
    if (DEMO) return start();
    state.pass = store.get(PASS_KEY);
    if (!state.pass) return lock();
    try { await start(); } catch (e) {
      if (e.code === 'auth') lock('Enter the passphrase.');
      else $app.replaceChildren(h('div', { class: 'problem gate' },
        h('p', null, `Couldn’t reach the sheet. ${e.message}`),
        h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again')));
    }
  })();
})();
