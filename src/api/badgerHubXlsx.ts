/**
 * Badger Hub XLSX parser.
 *
 * The new Badger Hub source ("badge list of badge challenges/badgers") is a
 * single Google spreadsheet with ~190 tabs: one "table of contents" tab listing
 * every badger, plus one tab per badger holding its badge list. Unlike gviz/CSV,
 * the **XLSX export** (`export?format=xlsx`) carries each cell's *fill color* —
 * the only signal that distinguishes legacy (green), normal (yellow/orange), and
 * skip (no fill) badgers. So the service worker fetches the workbook as binary
 * and this module unzips + parses it (no third-party lib — Chrome's
 * `DecompressionStream('deflate-raw')` inflates the zip entries).
 *
 * One workbook parse yields everything: the hub list (with color → legacy/normal
 * classification + a WIP flag from col F), and every badger tab's full badge list
 * with **exact** Roblox badge ids (col D is a real hyperlink, so row→badgeId is
 * 1:1 — no slug/sandwich matching needed). The result is plain JSON returned to
 * the content script, which owns all storage writes.
 *
 * Pure module: no `chrome.*` (so the SW bundle doesn't pull content-script deps).
 * Types are imported type-only from badgerHubSheet to stay erased at runtime.
 */

import type { BadgerGame, BadgerBadge } from './badgerHubSheet';

export interface ParsedBadgerHub {
  /** The hub list — only legacy (green) + normal (yellow) badgers, in sheet order. */
  games: BadgerGame[];
  /** Per-badger badge lists keyed by `${hubSheetId}:${tabName}` (the gamebadges cache key). */
  gamebadges: Record<string, BadgerBadge[]>;
}

// ── Minimal ZIP reader (DEFLATE via DecompressionStream) ────────────────────

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(bytes as unknown as BodyInit).body!.pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Unzips the entries whose name passes `wanted` into a name→text map. Reads the
 * End-Of-Central-Directory record, walks the central directory, then inflates
 * each wanted entry from its local header. No ZIP64 (the workbook is ~1.5 MB).
 */
async function unzipEntries(
  buf: ArrayBuffer,
  wanted: (name: string) => boolean
): Promise<Map<string, string>> {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const out = new Map<string, string>();

  // Find the End Of Central Directory record (sig 0x06054b50), searching back
  // from the end (the trailing comment is normally empty).
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 0x10000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('XLSX: no EOCD record');

  const entryCount = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true); // central directory offset

  const decoder = new TextDecoder('utf-8');
  // Read sizes + method from the CENTRAL directory — local headers may carry 0
  // sizes when a data descriptor is used (general-purpose bit 3), which Google's
  // export does. Feeding the wrong byte range to DecompressionStream throws.
  const targets: Array<{ name: string; localOffset: number; method: number; compSize: number }> = [];

  for (let n = 0; n < entryCount; n++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break; // central dir header sig
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const nameLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const localOffset = dv.getUint32(cd + 42, true);
    const name = decoder.decode(u8.subarray(cd + 46, cd + 46 + nameLen));
    if (wanted(name)) targets.push({ name, localOffset, method, compSize });
    cd += 46 + nameLen + extraLen + commentLen;
  }

  for (const { name, localOffset, method, compSize } of targets) {
    if (dv.getUint32(localOffset, true) !== 0x04034b50) continue; // local file header sig
    // Name/extra lengths come from the LOCAL header (they can differ from the
    // central directory's), but the compressed size comes from the central dir.
    const nameLen = dv.getUint16(localOffset + 26, true);
    const extraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + nameLen + extraLen;
    const compressed = u8.subarray(dataStart, dataStart + compSize);
    let bytes: Uint8Array;
    if (method === 0) {
      bytes = compressed; // stored
    } else if (method === 8) {
      bytes = await inflateRaw(compressed); // deflate
    } else {
      continue; // unsupported method
    }
    out.set(name, decoder.decode(bytes));
  }
  return out;
}

// ── XML helpers ─────────────────────────────────────────────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

// ── Styles: fill color per cell style index ─────────────────────────────────

interface StyleTable {
  /** xf (cell style) index → ARGB hex of its fill, or null when none. */
  styleArgb: (string | null)[];
}

function parseStyles(xml: string): StyleTable {
  const fillsBlock = /<fills[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? '';
  const fillArgb: (string | null)[] = [];
  for (const m of fillsBlock.matchAll(/<fill>([\s\S]*?)<\/fill>/g)) {
    const fg = /<fgColor[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(m[1]);
    fillArgb.push(fg ? fg[1] : null);
  }
  const xfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const styleArgb: (string | null)[] = [];
  for (const m of xfsBlock.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const fid = /fillId="(\d+)"/.exec(m[0]);
    const idx = fid ? Number(fid[1]) : 0;
    styleArgb.push(idx < fillArgb.length ? fillArgb[idx] : null);
  }
  return { styleArgb };
}

/** Classify a cell fill: green → legacy, yellow/orange → normal, else skip. */
export function classifyFill(argb: string | null | undefined): 'legacy' | 'normal' | null {
  if (!argb || argb.length < 6) return null;
  const hex = argb.slice(-6);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  // Green: green channel clearly dominant (e.g. B6D7A8).
  if (g >= r && g > b + 24 && g > 120) return 'legacy';
  // Yellow / orange: red+green high, blue notably lower (e.g. FFE599, FFA500).
  if (r > 150 && g > 90 && b < r - 30 && b < g) return 'normal';
  return null;
}

// ── Shared strings ──────────────────────────────────────────────────────────

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Concatenate all <t> runs within the string item.
    let text = '';
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1];
    out.push(decodeXml(text));
  }
  return out;
}

// ── Workbook + relationship mapping ─────────────────────────────────────────

interface SheetRef {
  name: string;
  rId: string;
}

function parseWorkbookSheets(xml: string): SheetRef[] {
  const out: SheetRef[] = [];
  for (const m of xml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const rId = /\br:id="([^"]*)"/.exec(m[0])?.[1];
    if (name && rId) out.push({ name: decodeXml(name), rId });
  }
  return out;
}

function parseRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && target) map.set(id, decodeXml(target));
  }
  return map;
}

// ── Worksheet cell access ───────────────────────────────────────────────────

interface RowCells {
  /** column letter → { value, styleIdx } */
  cells: Map<string, { v: string; s: number | null }>;
}

function colLetters(ref: string): string {
  return ref.replace(/\d+$/, '');
}

/** Parses a worksheet into rows keyed by row number, each with its cells by column. */
function parseSheetRows(xml: string, shared: string[]): Map<number, RowCells> {
  const rows = new Map<number, RowCells>();
  for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(rm[1]);
    const cells = new Map<string, { v: string; s: number | null }>();
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const col = colLetters(ref);
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const sAttr = /\bs="(\d+)"/.exec(attrs)?.[1];
      const s = sAttr != null ? Number(sAttr) : null;
      let v = '';
      if (t === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '-1');
        v = shared[idx] ?? '';
      } else if (t === 'inlineStr' || t === 'str') {
        const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        v = tm ? decodeXml(tm[1]) : decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vm) v = decodeXml(vm[1]);
        else {
          const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
          if (tm) v = decodeXml(tm[1]);
        }
      }
      cells.set(col, { v, s });
    }
    rows.set(rowNum, new RowCellsImpl(cells));
  }
  return rows;
}

class RowCellsImpl implements RowCells {
  constructor(public cells: Map<string, { v: string; s: number | null }>) {}
}

/** Maps each cell ref → its hyperlink location (internal `'tab'!A1`) or r:id. */
function parseHyperlinks(xml: string): Map<string, { location?: string; rId?: string }> {
  const map = new Map<string, { location?: string; rId?: string }>();
  const block = /<hyperlinks>([\s\S]*?)<\/hyperlinks>/.exec(xml)?.[1];
  if (!block) return map;
  for (const m of block.matchAll(/<hyperlink\b[^>]*\/?>/g)) {
    const ref = /\bref="([^"]*)"/.exec(m[0])?.[1];
    if (!ref) continue;
    const location = /\blocation="([^"]*)"/.exec(m[0])?.[1];
    const rId = /\br:id="([^"]*)"/.exec(m[0])?.[1];
    map.set(ref, { location: location ? decodeXml(location) : undefined, rId });
  }
  return map;
}

/** `'badger''s garden'!A1` → `badger's garden`. Returns null when not a tab ref. */
function tabFromLocation(location: string | undefined): string | null {
  if (!location) return null;
  const bang = location.lastIndexOf('!');
  if (bang < 0) return null;
  let name = location.slice(0, bang).trim();
  if (name.startsWith("'") && name.endsWith("'")) {
    name = name.slice(1, -1).replace(/''/g, "'");
  }
  return name || null;
}

const BADGE_LINK_RE = /roblox\.com\/badges\/(\d+)/i;
const GAME_LINK_RE = /roblox\.com\/games\/(\d+)/i;

/**
 * The badger's *own* game placeId — the topmost `roblox.com/games/{id}`
 * hyperlink in its tab (curators put it on row 2, col F/G). This is the
 * "owner banned" signal: when a badger's creator is banned, this game goes down.
 * Read from the sheet so we never need a Roblox request to resolve it.
 */
function firstGamePlaceId(xml: string, relsXml: string | undefined): number | undefined {
  const links = parseHyperlinks(xml);
  const rels = parseRels(relsXml);
  let best: { row: number; placeId: number } | null = null;
  for (const [ref, link] of links) {
    const url = link.rId ? rels.get(link.rId) : undefined;
    const m = url ? GAME_LINK_RE.exec(url) : null;
    if (!m) continue;
    const row = Number(ref.replace(/^[A-Z]+/, '')) || 0;
    if (!best || row < best.row) best = { row, placeId: Number(m[1]) };
  }
  return best?.placeId;
}

// ── Top-level parse ─────────────────────────────────────────────────────────

const TOC_NAMES = ['table of contents', 'tableofcontents'];

export async function parseBadgerHubWorkbook(
  buf: ArrayBuffer,
  hubSheetId: string
): Promise<ParsedBadgerHub> {
  const entries = await unzipEntries(buf, (name) =>
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/styles.xml' ||
    name === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name) ||
    /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name)
  );

  const workbookXml = entries.get('xl/workbook.xml');
  if (!workbookXml) throw new Error('XLSX: missing workbook.xml');
  const shared = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(entries.get('xl/sharedStrings.xml')!)
    : [];
  const { styleArgb } = parseStyles(entries.get('xl/styles.xml') ?? '');
  const sheets = parseWorkbookSheets(workbookXml);
  const wbRels = parseRels(entries.get('xl/_rels/workbook.xml.rels'));

  // rId → worksheet zip path; sheet name (lowercased) → worksheet zip path.
  const nameToPath = new Map<string, string>();
  for (const s of sheets) {
    const target = wbRels.get(s.rId);
    if (!target) continue;
    // Targets are relative to xl/ (e.g. "worksheets/sheet2.xml").
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    nameToPath.set(s.name.toLowerCase(), path);
  }

  const tocSheet =
    sheets.find((s) => TOC_NAMES.includes(s.name.toLowerCase().replace(/\s+/g, ' ').trim())) ??
    sheets.find((s) => /contents/i.test(s.name));
  const tocPath = tocSheet ? nameToPath.get(tocSheet.name.toLowerCase()) : undefined;
  if (!tocPath || !entries.has(tocPath)) throw new Error('XLSX: table of contents tab not found');

  const tocXml = entries.get(tocPath)!;
  const tocRows = parseSheetRows(tocXml, shared);
  const tocLinks = parseHyperlinks(tocXml);

  const games: BadgerGame[] = [];
  const gamebadges: Record<string, BadgerBadge[]> = {};
  let order = 0;

  // ToC layout: A=index, B=badger name (fill color), C=count, D=creator,
  // E=status (ignored), F=notes (WIP). Row 1 is the header.
  const sortedRowNums = [...tocRows.keys()].sort((a, b) => a - b);
  for (const rowNum of sortedRowNums) {
    if (rowNum === 1) continue; // header
    const row = tocRows.get(rowNum)!;
    const bCell = row.cells.get('B');
    const name = bCell?.v.trim();
    if (!name) continue;
    const argb = bCell && bCell.s != null ? styleArgb[bCell.s] : null;
    const cls = classifyFill(argb);
    if (!cls) continue; // skip white / grey / unfilled

    const notes = (row.cells.get('F')?.v ?? '').trim();
    const wip = /\bwip\b/i.test(notes);

    // The badger name cell links internally to that badger's tab.
    const tabName = tabFromLocation(tocLinks.get(`B${rowNum}`)?.location);
    const cacheKey = tabName ? `${hubSheetId}:${tabName}` : `${hubSheetId}:row${rowNum}`;

    // Resolve + parse this badger's tab now (one workbook → all badge lists), and
    // read its own game placeId from the sheet so we never have to fetch it.
    let placeId: number | undefined;
    if (tabName) {
      const path = nameToPath.get(tabName.toLowerCase());
      if (path && entries.has(path)) {
        const tabXml = entries.get(path)!;
        const tabRels = entries.get(path.replace(/^xl\/worksheets\//, 'xl/worksheets/_rels/') + '.rels');
        gamebadges[cacheKey] = parseBadgerTab(tabXml, tabRels, shared, name);
        placeId = firstGamePlaceId(tabXml, tabRels);
      }
    }

    games.push({
      order: ++order,
      sheetRow: rowNum,
      legacy: cls === 'legacy',
      wip,
      name,
      placeId,
      docRaw: tabName ?? name,
      docSheetId: hubSheetId,
      docGid: tabName ?? `row${rowNum}`,
      docUrl: `https://docs.google.com/spreadsheets/d/${hubSheetId}/edit`,
    });
  }

  return { games, gamebadges };
}

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * Locates the badge-name / game / link columns from a tab's header row. Most
 * tabs are `badge=B, game=C, link=D`, but some carry an extra column (e.g. a
 * "type" / "part names" column) that shifts everything right (`C/D/E`). Keying
 * off the header labels handles both; falls back to `B/C/D` if a label is
 * missing.
 */
function detectBadgerColumns(headerRow: RowCells | undefined): {
  badgeCol: string;
  gameCol: string;
  linkCol: string;
} {
  let badgeCol = '';
  let gameCol = '';
  let linkCol = '';
  if (headerRow) {
    for (const col of COLS) {
      const h = (headerRow.cells.get(col)?.v ?? '').trim().toLowerCase();
      if (!h) continue;
      if (!linkCol && h === 'link') linkCol = col;
      else if (!badgeCol && (h === 'badge name' || h === 'badge')) badgeCol = col;
      else if (!gameCol && h === 'game') gameCol = col;
    }
  }
  return { badgeCol: badgeCol || 'B', gameCol: gameCol || 'C', linkCol: linkCol || 'D' };
}

/**
 * Parses one badger tab into a badge list. Columns are detected from the header
 * row (the badge link is a real `roblox.com/badges/{id}` hyperlink in the "link"
 * column), so row→id is exact.
 */
function parseBadgerTab(
  xml: string,
  relsXml: string | undefined,
  shared: string[],
  fallbackGameName: string
): BadgerBadge[] {
  const rows = parseSheetRows(xml, shared);
  const links = parseHyperlinks(xml);
  const rels = parseRels(relsXml);
  const { badgeCol, gameCol, linkCol } = detectBadgerColumns(rows.get(1));
  const out: BadgerBadge[] = [];
  let order = 0;
  const rowNums = [...rows.keys()].sort((a, b) => a - b);
  for (const rowNum of rowNums) {
    if (rowNum === 1) continue; // header row
    const row = rows.get(rowNum)!;
    const badge = (row.cells.get(badgeCol)?.v ?? '').trim();
    const game = (row.cells.get(gameCol)?.v ?? '').trim();
    if (!badge && !game) continue;

    // Badge id from the link-column hyperlink (external r:id → roblox url). Fall
    // back to any roblox badge hyperlink/text in the row: a few tabs have the
    // link on the badge-name cell or a shifted helper column, and one unresolved
    // row can otherwise block a whole list from ever being counted complete.
    let badgeId: number | null = null;
    let url: string | undefined;
    const link = links.get(`${linkCol}${rowNum}`);
    if (link?.rId) url = rels.get(link.rId);
    if (!url) {
      const cellText = row.cells.get(linkCol)?.v ?? '';
      if (BADGE_LINK_RE.test(cellText)) url = cellText;
    }
    if (!url) {
      for (const col of COLS) {
        const rowLink = links.get(`${col}${rowNum}`);
        const rowUrl = rowLink?.rId ? rels.get(rowLink.rId) : undefined;
        if (rowUrl && BADGE_LINK_RE.test(rowUrl)) {
          url = rowUrl;
          break;
        }
        const cellText = row.cells.get(col)?.v ?? '';
        if (BADGE_LINK_RE.test(cellText)) {
          url = cellText;
          break;
        }
      }
    }
    if (url) {
      const m = BADGE_LINK_RE.exec(url);
      if (m) badgeId = Number(m[1]);
    }

    out.push({ order: ++order, game: game || fallbackGameName, badge, badgeId });
  }
  return out;
}
