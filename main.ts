// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls). It reads a patch
// in one of the four formats, finds the lines each edit names at the first of three matching
// tiers, and changes every file or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they
// are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into lines (SPEC.md section 3). */
interface SplitFile {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Whether the path exists as the tree stands: a pending creation, or any entry on disk (a file or a directory). */
  existsAny(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

/** Matching tiers (SPEC.md section 5). */
type Tier = 0 | 1 | 2;

function normLine(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: Tier): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: Tier; occ: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences starting at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: Tier; occ: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to the single line `anchor`, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Tier 2 re-indentation: replace O's first line's leading whitespace with the file's. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  backslash: boolean;
}

/** Split body items into old lines O and new-line entries N. */
interface NEntry {
  ctx: boolean;
  oIndex: number;
  text: string;
}

function splitON(items: BodyItem[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ ctx: true, oIndex: o.length - 1, text: '' });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      n.push({ ctx: false, oIndex: -1, text: it.text });
    }
  }
  return { o, n };
}

/** Build N: context lines as the file's own matched lines, other lines re-indented at tier 2. */
function buildN(n: NEntry[], matched: string[], o: string[], tier: Tier): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = matched.length > 0 ? leadWs(matched[0]!) : '';
  return n.map((e) => {
    if (e.ctx) return matched[e.oIndex]!;
    return tier === 2 ? reindent(e.text, p, f) : e.text;
  });
}

/** Whether a `\` line follows the hunk's last context or `+` line (for the final line break). */
function lastCtxOrNewBackslash(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.backslash;
  }
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.existsAny(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk (SPEC.md section 6). */
interface Hunk {
  a: number;
  items: BodyItem[];
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitON(h.items);
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = pos === f.lines.length;
      const newLines = n.map((e) => e.text);
      f.lines.splice(pos, 0, ...newLines);
      if (atEnd) f.ends = !lastCtxOrNewBackslash(h.items);
      d += newLines.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const matched = f.lines.slice(best, best + o.length);
    const newLines = buildN(n, matched, o, found.tier);
    const runsToEnd = best + o.length === f.lines.length;
    f.lines.splice(best, o.length, ...newLines);
    if (runsToEnd) f.ends = !lastCtxOrNewBackslash(h.items);
    d += newLines.length - o.length;
  }
  return joinFile(f);
}

/** One unified section (SPEC.md section 6). */
interface Section {
  dashOld: string | undefined;
  dashNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseDiffPath(raw: string): string {
  const cut = raw.split('\t')[0]!;
  let p = cut.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, i: number): Hunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return { a: parseInt(m[1]!, 10), items: [] };
}

/** Parse a hunk body starting at `start`; returns the index after the body. */
function parseHunkBody(lines: string[], start: number, hunk: Hunk): number {
  let i = start;
  const raw: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      i++;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  for (const l of raw) {
    if (l.startsWith('\\')) {
      const prev = hunk.items[hunk.items.length - 1];
      if (prev) prev.backslash = true;
      continue;
    }
    if (l === '') hunk.items.push({ kind: 'ctx', text: '', backslash: false });
    else if (l[0] === ' ') hunk.items.push({ kind: 'ctx', text: l.slice(1), backslash: false });
    else if (l[0] === '-') hunk.items.push({ kind: 'old', text: l.slice(1), backslash: false });
    else hunk.items.push({ kind: 'new', text: l.slice(1), backslash: false });
  }
  return i;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const blankSection = (): Section => ({
    dashOld: undefined,
    dashNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = blankSection();
        sections.push(cur);
        inHeader = true;
      }
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.dashOld = parseDiffPath(line.slice(4));
        cur.dashNew = parseDiffPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.dashNew = parseDiffPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line, i);
        inHeader = false;
        cur.hunks.push(h);
        i = parseHunkBody(lines, i + 1, h);
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunkHeader(line, i);
      cur.hunks.push(h);
      i = parseHunkBody(lines, i + 1, h);
      continue;
    }
    i++;
  }
  return sections.map((sec) => sectionEdit(sec, strict));
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = sec.dashOld ?? sec.renameFrom ?? sec.diffOld;
    const newRaw = sec.dashNew ?? sec.renameTo ?? sec.diffNew;
    if (oldRaw === undefined && newRaw === undefined) return;
    const o: string | null = oldRaw === undefined ? (newRaw === '/dev/null' ? null : (newRaw as string)) : oldRaw === '/dev/null' ? null : oldRaw;
    const n: string | null = newRaw === undefined ? (oldRaw === '/dev/null' ? null : (oldRaw as string)) : newRaw === '/dev/null' ? null : newRaw;
    if (o === null && n === null) return;
    if (o !== null && !safe(o)) throw new Fail('unsafe', o);
    if (n !== null && !safe(n)) throw new Fail('unsafe', n);
    const isCreate = o === null || sec.newFile;
    const isDelete = n === null || sec.deletedFile;
    if (isCreate) {
      if (n === null) return;
      if (tree.existsAny(n)) throw new Fail('exists', n);
      const plus: string[] = [];
      let lastNew: BodyItem | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            lastNew = it;
          }
        }
      }
      const ends = !(lastNew !== null && lastNew.backslash);
      tree.now.set(n, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (o === null) return;
      if (tree.get(o) === null) throw new Fail('missing', o);
      tree.now.set(o, null);
      return;
    }
    if (o !== n) {
      if (tree.get(o!) === null) throw new Fail('missing', o!);
      if (tree.existsAny(n!)) throw new Fail('exists', n!);
      const result = applyHunks(tree.get(o!)!, sec.hunks, strict, o!);
      tree.now.set(o!, null);
      tree.now.set(n!, result);
      tree.moves.push({ old: o!, new: n! });
      return;
    }
    if (tree.get(o!) === null) throw new Fail('missing', o!);
    tree.now.set(o!, applyHunks(tree.get(o!)!, sec.hunks, strict, o!));
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let j = prevEnd; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        eq = j;
        break;
      }
      if (l === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.existsAny(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const matched = f.lines.slice(at, at + oldLines.length);
    const entries: NEntry[] = newLines.map((t) => ({ ctx: false, oIndex: -1, text: t }));
    f.lines.splice(at, oldLines.length, ...buildN(entries, matched, oldLines, found.tier));
    tree.now.set(path, joinFile(f));
  };
}

/** V4A patches (SPEC.md section 8). */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const start = i + 1;
      let j = start;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      let end = j;
      while (end > start && blank(lines[end - 1]!)) end--;
      const fileLines: string[] = [];
      for (let k = start; k < end; k++) {
        const l = lines[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const start = i + 1;
      let j = start;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      for (let k = start; k < j; k++) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let k = i + 1;
      let moveTo: string | null = null;
      if (k < last && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      let j = k;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      let end = j;
      while (end > k && blank(lines[end - 1]!)) end--;
      const chunks: V4aChunk[] = [];
      let c = k;
      let firstChunk = true;
      while (c < end) {
        const l = lines[c]!;
        let anchor: string | null = null;
        let eof = false;
        if (l.startsWith('@@')) {
          anchor = l.slice(2).trim();
          if (anchor === '') anchor = null;
          c++;
        } else if (!firstChunk) {
          throw new Exit2(`error: parse ${c + 1}`);
        }
        const bodyStart = c;
        let b = c;
        while (b < end) {
          const bl = lines[b]!;
          if (bl.startsWith('@@')) break;
          if (bl.trim() === '*** End of File') break;
          if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl === '') {
            b++;
            continue;
          }
          throw new Exit2(`error: parse ${b + 1}`);
        }
        if (b < end && lines[b]!.trim() === '*** End of File') {
          eof = true;
          b++;
        }
        const bodyEnd = eof ? b - 1 : b;
        const items: BodyItem[] = [];
        for (let m = bodyStart; m < bodyEnd; m++) {
          const bl = lines[m]!;
          if (bl === '') items.push({ kind: 'ctx', text: '', backslash: false });
          else if (bl[0] === ' ') items.push({ kind: 'ctx', text: bl.slice(1), backslash: false });
          else if (bl[0] === '-') items.push({ kind: 'old', text: bl.slice(1), backslash: false });
          else items.push({ kind: 'new', text: bl.slice(1), backslash: false });
        }
        chunks.push({ anchor, eof, items });
        c = b;
        firstChunk = false;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.existsAny(path)) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.existsAny(moveTo)) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(f.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitON(chunk.items);
      if (o.length === 0) {
        const pos = chunk.eof ? f.lines.length : cursor;
        const newLines = n.map((e) => e.text);
        f.lines.splice(pos, 0, ...newLines);
        cursor = pos + newLines.length;
        continue;
      }
      const found = findTierFrom(f.lines, o, cursor, strict);
      if (!found) throw new Fail('no-match', path);
      let at = found.occ[0]!;
      if (chunk.eof) {
        const eofPos = f.lines.length - o.length;
        if (eofPos < cursor || !found.occ.includes(eofPos)) throw new Fail('no-match', path);
        at = eofPos;
      }
      const matched = f.lines.slice(at, at + o.length);
      const newLines = buildN(n, matched, o, found.tier);
      f.lines.splice(at, o.length, ...newLines);
      cursor = at + newLines.length;
    }
    const result = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Writes happen only after every edit succeeded; still, a write can fail (a parent path is a file,
    // permissions), so apply them with a rollback: deletes first, then writes, restoring on any error
    // so a failed run leaves no file written (SPEC section 10).
    const ops: { p: string; now: string | null }[] = [];
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      ops.push({ p, now });
    }
    const ordered = [...ops.filter((o) => o.now === null), ...ops.filter((o) => o.now !== null)];
    const backup = new Map<string, string | null>();
    const applied: { p: string; now: string | null }[] = [];
    try {
      for (const op of ordered) {
        if (!backup.has(op.p)) {
          let prev: string | null = null;
          try {
            prev = readFileSync(op.p, 'utf8');
          } catch {
            prev = null;
          }
          backup.set(op.p, prev);
        }
        if (op.now === null) rmSync(op.p, { force: true });
        else {
          mkdirSync(dirname(op.p), { recursive: true });
          writeFileSync(op.p, op.now);
        }
        applied.push(op);
      }
    } catch {
      for (const op of [...applied].reverse()) {
        try {
          const prev = backup.get(op.p);
          if (prev === null) rmSync(op.p, { force: true });
          else {
            mkdirSync(dirname(op.p), { recursive: true });
            writeFileSync(op.p, prev);
          }
        } catch {
          // Best effort: the run already failed; leave the tree as close to untouched as possible.
        }
      }
      return { code: 1, out: [] };
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
