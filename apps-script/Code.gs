/**
 * Grading sheet backend.
 *
 * Paste this file into Extensions → Apps Script of the Google Sheet that
 * should hold the marks, set a PASSPHRASE in Project Settings → Script
 * Properties, and deploy it as a web app (see README.md).
 *
 * Every session × exercise pair gets its own tab, named
 * "<session short> <exercise short>", e.g. "Tue 10-12 Ex1".
 */

// Sessions and exercises. The website reads this list, so this is the only
// place it needs to change. To add the video, uncomment the Video line,
// run setupTabs() once and deploy a new version.
const SESSIONS = [
  { id: 'tue-10', label: 'Tuesday 10–12',   short: 'Tue 10-12' },
  { id: 'wed-12', label: 'Wednesday 12–14', short: 'Wed 12-14' },
  { id: 'wed-14', label: 'Wednesday 14–16', short: 'Wed 14-16' },
  { id: 'thu-12', label: 'Thursday 12–14',  short: 'Thu 12-14' },
  { id: 'thu-14', label: 'Thursday 14–16',  short: 'Thu 14-16' },
];

const EXERCISES = [
  { id: 'ex1', label: 'Exercise 1', short: 'Ex1' },
  { id: 'ex2', label: 'Exercise 2', short: 'Ex2' },
  { id: 'ex3', label: 'Exercise 3', short: 'Ex3' },
  // { id: 'video', label: 'Video', short: 'Video' },
];

const HEADERS = ['Groups', 'Members-Name', 'Members-idm', 'Missing', 'Pass/Fail', 'Comment'];
const COL = { group: 1, name: 2, idm: 3, missing: 4, result: 5, comment: 6 };
const ALLOWED = {
  missing: ['', 'Yes'],
  result: ['', 'Pass', 'Fail'],
};
const MAX_TEXT = 500;

/* ---------- web app entry points ---------- */

function doGet() {
  return json_({ ok: true, message: 'Grading backend is running. The website talks to it with POST requests.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'The request was not valid JSON.' });
  }

  const pass = PropertiesService.getScriptProperties().getProperty('PASSPHRASE');
  if (!pass) {
    return json_({ ok: false, error: 'No PASSPHRASE is set in the script properties.' });
  }
  if (req.passphrase !== pass) {
    return json_({ ok: false, code: 'auth', error: 'Wrong passphrase.' });
  }

  try {
    switch (req.action) {
      case 'config':
        return json_({ ok: true, sessions: SESSIONS, exercises: EXERCISES });
      case 'load':
        return json_({ ok: true, data: loadSession_(req.session) });
      case 'saveRoster':
        return json_(withLock_(function () { return saveRoster_(req.session, req.groups); }));
      case 'setCell':
        return json_(withLock_(function () {
          return setCell_(req.session, req.exercise, req.idm, req.field, req.value);
        }));
      default:
        return json_({ ok: false, error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ---------- sheet menu ---------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Grading')
    .addItem('Create all session tabs', 'setupTabs')
    .addToUi();
}

/** Creates every session × exercise tab that does not exist yet. Safe to run again. */
function setupTabs() {
  SESSIONS.forEach(function (s) {
    EXERCISES.forEach(function (e) { getTab_(s, e, true); });
  });
}

/* ---------- actions ---------- */

function loadSession_(sessionId) {
  const session = findSession_(sessionId);
  const out = { exercises: {} };
  EXERCISES.forEach(function (ex) {
    const sh = getTab_(session, ex, false);
    out.exercises[ex.id] = sh ? readRows_(sh) : [];
  });
  return out;
}

function saveRoster_(sessionId, groups) {
  const session = findSession_(sessionId);
  if (!Array.isArray(groups) || !groups.length) throw new Error('The student list is empty.');

  // Validate once before touching any tab.
  const seen = {};
  const clean = groups.map(function (g) {
    const num = parseInt(g.num, 10);
    if (!(num > 0)) throw new Error('Every group needs a number.');
    if (!Array.isArray(g.members) || !g.members.length) throw new Error('Group ' + num + ' has no members.');
    return {
      num: num,
      members: g.members.map(function (m) {
        const idm = String(m.idm || '').trim();
        const name = String(m.name || '').trim();
        if (!idm) throw new Error('A student in group ' + num + ' has no idm.');
        const key = idm.toLowerCase();
        if (seen[key]) throw new Error('The idm ' + idm + ' appears twice.');
        seen[key] = true;
        return { name: name.slice(0, MAX_TEXT), idm: idm.slice(0, 50) };
      }),
    };
  });

  EXERCISES.forEach(function (ex) {
    const sh = getTab_(session, ex, true);
    const old = {};
    readRows_(sh).forEach(function (r) { old[r.idm.toLowerCase()] = r; });

    const values = [];
    const groupStarts = [];
    clean.forEach(function (g) {
      groupStarts.push(values.length + 2);
      g.members.forEach(function (m, i) {
        const prev = old[m.idm.toLowerCase()] || {};
        values.push([
          i === 0 ? g.num : '',
          safe_(m.name),
          safe_(m.idm),
          prev.missing || '',
          prev.result || '',
          safe_(prev.comment || ''),
        ]);
      });
    });

    const last = sh.getLastRow();
    if (last > 1) {
      const range = sh.getRange(2, 1, last - 1, HEADERS.length);
      range.clearContent();
      range.setBorder(false, false, false, false, false, false);
    }
    sh.getRange(2, 1, values.length, HEADERS.length).setValues(values);
    groupStarts.forEach(function (row) {
      sh.getRange(row, 1, 1, HEADERS.length)
        .setBorder(true, null, null, null, null, null, '#5f7f4a', SpreadsheetApp.BorderStyle.SOLID);
    });
  });

  return { ok: true };
}

function setCell_(sessionId, exerciseId, idm, field, value) {
  const session = findSession_(sessionId);
  const ex = findExercise_(exerciseId);
  if (!(field in COL) || field === 'group' || field === 'name' || field === 'idm') {
    throw new Error('That column cannot be changed from the website.');
  }
  value = value == null ? '' : String(value);
  if (ALLOWED[field] && ALLOWED[field].indexOf(value) === -1) {
    throw new Error('"' + value + '" is not a valid value for ' + field + '.');
  }
  value = value.slice(0, MAX_TEXT);

  const sh = getTab_(session, ex, false);
  if (!sh) throw new Error('The tab for this exercise does not exist yet. Save the student list first.');

  const last = sh.getLastRow();
  if (last < 2) throw new Error('This tab has no students yet.');
  const ids = sh.getRange(2, COL.idm, last - 1, 1).getValues();
  const want = String(idm || '').trim().toLowerCase();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim().toLowerCase() === want) {
      sh.getRange(i + 2, COL[field]).setValue(field === 'comment' ? safe_(value) : value);
      return { ok: true };
    }
  }
  throw new Error('No student with idm ' + idm + ' in ' + sh.getName() + '. Reload the page.');
}

/* ---------- helpers ---------- */

function readRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const rows = [];
  let group = '';
  values.forEach(function (v) {
    if (v[0] !== '' && v[0] !== null) group = v[0];
    const idm = String(v[2]).trim();
    const name = String(v[1]).trim();
    if (!idm && !name) return;
    rows.push({
      group: group === '' ? '' : Number(group) || String(group),
      name: name,
      idm: idm,
      missing: String(v[3]).trim(),
      result: String(v[4]).trim(),
      comment: String(v[5]),
    });
  });
  return rows;
}

function getTab_(session, ex, create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = session.short + ' ' + ex.short;
  let sh = ss.getSheetByName(name);
  if (sh || !create) return sh;

  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 70);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidth(3, 120);
  sh.setColumnWidth(4, 80);
  sh.setColumnWidth(5, 90);
  sh.setColumnWidth(6, 320);
  sh.getRange('D2:D').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Yes'], true).setAllowInvalid(false).build());
  sh.getRange('E2:E').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Pass', 'Fail'], true).setAllowInvalid(false).build());
  return sh;
}

function findSession_(id) {
  for (let i = 0; i < SESSIONS.length; i++) if (SESSIONS[i].id === id) return SESSIONS[i];
  throw new Error('Unknown session: ' + id);
}

function findExercise_(id) {
  for (let i = 0; i < EXERCISES.length; i++) if (EXERCISES[i].id === id) return EXERCISES[i];
  throw new Error('Unknown exercise: ' + id);
}

// Stops text like "=IMPORTXML(...)" from being run as a formula.
function safe_(text) {
  text = String(text == null ? '' : text);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('The sheet is busy. Try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
