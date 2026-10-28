/*
 * Turns a pasted student list into groups.
 *
 * Understands, one student per line:
 *   1<TAB>Anna Berger<TAB>ab12cdef      (copied from a spreadsheet; group number
 *   <TAB>Ben Croft<TAB>cd34efgh          only on the first member is fine)
 *   2, Clara Diaz, ef56ghij              (comma or semicolon separated)
 *   Group 3                               (a heading line, members below)
 *   Dan Eck (gh78ijkl)                    (idm in brackets, or an email)
 *   ...and blank lines between groups when there are no numbers.
 */
(function (root) {
  'use strict';

  const IDM_STRICT = /^[a-z]{2}\d{2}[a-z]{4}$/i;            // FAU style: ab12cdef
  const IDM_LOOSE = /^(?=.*\d)(?=.*[a-z])[a-z0-9._-]{4,24}$/i; // anything id-like
  const HEADER_WORDS = /\b(name|names|idm|members?|group|groups|gruppe|vorname|nachname|matr\w*)\b/i;
  const GROUP_LINE = /^(?:group|gruppe|team|g)\s*(?:no\.?|nr\.?|#)?\s*(\d{1,3})\s*:?\s*$/i;
  const GROUP_CELL = /^(?:(?:group|gruppe|team|g)\s*(?:no\.?|nr\.?|#)?\s*)?(\d{1,3})$/i;

  function cleanIdm(t) {
    t = String(t).trim().replace(/^[(\[<"']+/, '').replace(/[)\]>"',;.]+$/, '');
    const at = t.indexOf('@');
    if (at > 0) t = t.slice(0, at);
    return t;
  }

  function idmScore(t) {
    const c = cleanIdm(t);
    if (IDM_STRICT.test(c)) return 2;
    if (IDM_LOOSE.test(c)) return 1;
    return 0;
  }

  function splitCells(line) {
    if (line.indexOf('\t') !== -1) return { cells: line.split('\t').map(s => s.trim()), tabbed: true };
    if (line.indexOf(';') !== -1) return { cells: line.split(';').map(s => s.trim()), tabbed: false };
    if (line.indexOf(',') !== -1) return { cells: line.split(',').map(s => s.trim()), tabbed: false };
    if (/\S\s{2,}\S/.test(line.trim())) return { cells: line.trim().split(/\s{2,}/), tabbed: false };
    return { cells: line.trim().split(/\s+/), tabbed: false, words: true };
  }

  function parseLine(line) {
    const split = splitCells(line);
    let cells = split.cells;
    const continues = split.tabbed && cells[0] === '';
    cells = cells.filter(c => c !== '');
    if (!cells.length) return null;

    let group = null;
    const gm = cells.length > 1 && cells[0].match(GROUP_CELL);
    if (gm) {
      group = parseInt(gm[1], 10);
      cells = cells.slice(1);
    } else if (!split.words) {
      // "1 Anna Berger, ab12cdef": group number written in front of the name
      const lead = cells[0].match(/^(\d{1,3})[.)]?\s+(\S.*)$/);
      if (lead) {
        group = parseInt(lead[1], 10);
        cells[0] = lead[2];
      }
    }

    // Long pure numbers are matriculation numbers; they are not part of the name.
    cells = cells.filter(c => !/^\d{5,}$/.test(c));

    // Find the idm: a whole cell first, then a bracketed part or the last word of a cell.
    let idm = '';
    let best = 0;
    let bestAt = -1;
    cells.forEach((c, i) => {
      const s = /\s/.test(c) ? 0 : idmScore(c);
      if (s > best) { best = s; bestAt = i; }
    });
    if (bestAt >= 0) {
      idm = cleanIdm(cells[bestAt]);
      cells.splice(bestAt, 1);
    } else {
      for (let i = cells.length - 1; i >= 0 && !idm; i--) {
        const bracket = cells[i].match(/[(\[<]([^)\]>]+)[)\]>]/);
        if (bracket && idmScore(bracket[1])) {
          idm = cleanIdm(bracket[1]);
          cells[i] = cells[i].replace(bracket[0], '').trim();
          continue;
        }
        const words = cells[i].split(/\s+/);
        const lastWord = words[words.length - 1];
        if (words.length > 1 && idmScore(lastWord)) {
          idm = cleanIdm(lastWord);
          cells[i] = words.slice(0, -1).join(' ');
        }
      }
    }

    // Nothing looked like an idm, but the line is split into columns:
    // take the last single-word column and let the preview warn about it.
    let unusual = false;
    if (!idm && !split.words && cells.length >= 2 && !/\s/.test(cells[cells.length - 1]) && !HEADER_WORDS.test(line)) {
      idm = cleanIdm(cells.pop());
      unusual = true;
    }

    cells = cells.filter(c => c !== '');
    const name = split.words ? cells.join(' ') : cells.join(split.tabbed ? ' ' : ', ');

    if (!idm && group === null && HEADER_WORDS.test(line)) return { header: true };
    if (!idm && !name) return null;
    return { group, continues, name: name.replace(/\s+/g, ' ').trim(), idm, unusual };
  }

  function chunkSizes(n) {
    // Groups of 3, with the remainder made into groups of 2 (7 → 3, 2, 2).
    if (n <= 3) return [n];
    const sizes = [];
    let threes = Math.floor(n / 3);
    let rest = n % 3;
    if (rest === 1) { threes -= 1; rest = 4; }
    for (let i = 0; i < threes; i++) sizes.push(3);
    while (rest > 0) { sizes.push(2); rest -= 2; }
    return sizes;
  }

  function parseRoster(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const groups = [];
    const byNum = new Map();
    const warnings = [];
    const errors = [];
    let cur = null;
    let explicit = false;
    let blankBefore = false;
    let blockSplit = false;

    function newGroup(num) {
      if (num !== null && byNum.has(num)) return byNum.get(num);
      const g = { num, members: [] };
      groups.push(g);
      if (num !== null) byNum.set(num, g);
      return g;
    }

    lines.forEach((raw, idx) => {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { blankBefore = true; return; }

      const heading = line.trim().match(GROUP_LINE);
      if (heading) {
        cur = newGroup(parseInt(heading[1], 10));
        explicit = true;
        blankBefore = false;
        return;
      }

      const p = parseLine(line);
      if (!p || p.header) { blankBefore = false; return; }

      if (p.group !== null) {
        explicit = true;
        cur = newGroup(p.group);
      } else if (p.continues && cur) {
        // same group as the line above
      } else if (blankBefore && cur && cur.members.length && !explicit) {
        cur = newGroup(null);
        blockSplit = true;
      } else if (!cur) {
        cur = newGroup(null);
      }
      blankBefore = false;

      if (!p.idm) errors.push(`Line ${idx + 1} (“${line.trim()}”) has no idm. Put it after the name, separated by a comma or tab.`);
      else if (p.unusual) warnings.push(`Line ${idx + 1}: “${p.idm}” doesn’t look like an FAU idm (like ab12cdef). Check it before saving.`);
      cur.members.push({ name: p.name, idm: p.idm, line: idx + 1 });
    });

    let result = groups.filter(g => g.members.length);

    if (!explicit && !blockSplit && result.length === 1 && result[0].members.length > 3) {
      const all = result[0].members;
      result = [];
      let at = 0;
      chunkSizes(all.length).forEach(size => {
        result.push({ num: null, members: all.slice(at, at + size) });
        at += size;
      });
      warnings.push('The list had no group numbers or blank lines between groups, so students were put into groups of 3 (and 2) in list order. Check this before saving.');
    }

    // Number the groups that came without a number.
    let next = result.reduce((m, g) => (g.num !== null && g.num > m ? g.num : m), 0) + 1;
    result.forEach(g => { if (g.num === null) g.num = next++; });
    result.sort((a, b) => a.num - b.num);

    const seen = new Map();
    result.forEach(g => {
      if (g.members.length > 3) warnings.push(`Group ${g.num} has ${g.members.length} members.`);
      if (g.members.length === 1) warnings.push(`Group ${g.num} has only one member.`);
      g.members.forEach(m => {
        if (!m.idm) return;
        const k = m.idm.toLowerCase();
        if (seen.has(k)) errors.push(`The idm ${m.idm} appears twice (lines ${seen.get(k)} and ${m.line}).`);
        else seen.set(k, m.line);
      });
    });

    return { groups: result, warnings, errors };
  }

  const api = { parseRoster, parseLine, chunkSizes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RosterParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
