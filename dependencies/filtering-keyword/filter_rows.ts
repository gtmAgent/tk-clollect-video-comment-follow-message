/**
 * Parse free-form / tabular text; filter by keywords + actual publish time
 * (采集时间 − 评论日期相对时长).
 */

export const COL_ACTUAL_PUBLISH = '实际发布时间';

export type TableData = {
  headers: string[];
  rows: string[][];
  delimiter: string;
  commentDateIndex: number | null;
  collectTimeIndex: number | null;
  /** Absolute publish-time column fallback (excl. 评论日期 / 采集时间). */
  timeColumnIndex: number | null;
  /** Existing 实际发布时间 column when source already has it. */
  actualPublishIndex: number | null;
  /** 点赞数 column index when detected. */
  likeColumnIndex: number | null;
  usedHeaderRow: boolean;
};

export type FilterOptions = {
  keywords: string[];
  /** Inclusive lower bound; null = no lower bound. Time filter on if either bound set. */
  publishStartSec: number | null;
  /** Inclusive upper bound; null = no upper bound. */
  publishEndSec: number | null;
  /** Inclusive like-count range; null = no bound. */
  likeMin: number | null;
  likeMax: number | null;
};

export type ResolvePublishResult = {
  sec: number | null;
  fromCollectComment: boolean;
  /** Human-readable formula used for this row. */
  explain: string;
  commentRaw: string;
  collectRaw: string;
};

export type FilterResult = {
  headers: string[];
  matched: string[][];
  totalRows: number;
  skippedOutOfRange: number;
  skippedNoTime: number;
  skippedOutOfLike: number;
  skippedNoLike: number;
  timeFilterApplied: boolean;
  likeFilterApplied: boolean;
  usedCollectCommentFormula: boolean;
  /** How columns were detected. */
  detectNote: string;
  /** Sample explains for summary (up to N). */
  explainSamples: string[];
};

const COMMENT_DATE_RE =
  /评论\s*日期|評論\s*日期|comment\s*date|相对\s*时间|相對\s*時間|relative\s*time/i;
const COLLECT_TIME_RE =
  /采集\s*时间|採集\s*時間|采集\s*時間|crawl\s*time|collect(ion|ed)?\s*time|scraped?\s*(at|time)?/i;
/** Absolute publish date/time column (发布日期 / 发布时间). Not 实际发布时间 output. */
const ABS_PUBLISH_RE =
  /(?<!实际|實際)发布\s*日期|(?<!实际|實際)發佈\s*日期|(?<!实际|實際)发布\s*时间|(?<!实际|實際)發佈\s*時間|publish\s*date|publish\s*time|published(\s*at)?|post\s*(date|time)/i;
const LIKE_HEADER_RE =
  /点赞|按讚|讚數|赞数|likes?|digg|hearts?|favorite|favourite|爱心/i;
const ACTUAL_PUBLISH_HEADER_RE = /^实际\s*发布\s*时间$|^實際\s*發佈\s*時間$/i;
export const COL_LIKE_PARSED = '点赞数(数值)';

function detectDelimiter(line: string): string | null {
  const tabs = (line.match(/\t/g) ?? []).length;
  if (tabs > 0) return '\t';
  const commas = (line.match(/,/g) ?? []).length;
  if (commas > 0) return ',';
  // Multi-space columns (common when pasting from some UIs)
  const multi = (line.match(/\s{2,}/g) ?? []).length;
  if (multi >= 2) return ' multispace';
  return null;
}

/** Split a CSV/TSV line; supports simple double-quoted fields. */
export function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === ' multispace') {
    return line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
  }
  if (delimiter === '\t') {
    return line.split('\t').map((c) => c.trim());
  }
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function findHeaderIndex(headers: string[], re: RegExp): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (re.test(headers[i] ?? '')) return i;
  }
  return null;
}

function findAbsPublishIndex(
  headers: string[],
  commentIdx: number | null,
  collectIdx: number | null,
): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (i === commentIdx || i === collectIdx) continue;
    const h = headers[i] ?? '';
    if (COMMENT_DATE_RE.test(h) || COLLECT_TIME_RE.test(h)) continue;
    if (/^实际发布时间$|^實際發布時間$/i.test(h.trim())) continue;
    if (ABS_PUBLISH_RE.test(h)) return i;
  }
  return null;
}

function looksLikeHeaderRow(cells: string[]): boolean {
  if (
    cells.some(
      (c) =>
        COMMENT_DATE_RE.test(c) ||
        COLLECT_TIME_RE.test(c) ||
        ABS_PUBLISH_RE.test(c) ||
        /实际\s*发布|實際\s*發佈/i.test(c),
    )
  ) {
    return true;
  }
  const joined = cells.join(' ');
  if (
    /文案|标题|標題|内容|內容|链接|連結|用户|用戶|昵称|暱稱|ID|任务|任務|评论|采集|发布|点赞/i.test(
      joined,
    )
  ) {
    return true;
  }
  return !cells.some((c) => parseAbsoluteTime(c) != null);
}

function syntheticHeaders(width: number): string[] {
  return Array.from({ length: width }, (_, i) => (width === 1 ? '内容' : `列${i + 1}`));
}

function normalizeRows(rows: string[][], width: number): string[][] {
  return rows.map((r) => {
    const cells = [...r];
    while (cells.length < width) cells.push('');
    return cells.slice(0, width);
  });
}

/**
 * Accept any text: plain lines, TSV, or CSV. No required column names.
 */
export function parseTableText(raw: string): TableData {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) {
    throw new Error('内容为空，请粘贴文本或选择文件');
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 1) {
    throw new Error('内容为空，请粘贴文本或选择文件');
  }

  const delimiter = detectDelimiter(lines[0]!) ?? detectDelimiter(lines[1] ?? '') ?? '\t';
  const isDelimited = lines.some((l) => detectDelimiter(l) != null);

  if (!isDelimited) {
    return {
      headers: ['内容'],
      rows: lines.map((l) => [l.trim()]),
      delimiter: '\t',
      commentDateIndex: null,
      collectTimeIndex: null,
      timeColumnIndex: null,
      actualPublishIndex: null,
      likeColumnIndex: null,
      usedHeaderRow: false,
    };
  }

  const firstCells = splitLine(lines[0]!, delimiter);
  const useHeader = looksLikeHeaderRow(firstCells);
  const headers = useHeader
    ? firstCells.map((h) => h.trim() || '列')
    : syntheticHeaders(firstCells.length);
  const dataLines = useHeader ? lines.slice(1) : lines;
  if (dataLines.length === 0) {
    throw new Error('只有表头、没有数据行');
  }
  const width = Math.max(
    headers.length,
    ...dataLines.map((line) => splitLine(line, delimiter).length),
  );
  const finalHeaders =
    headers.length >= width ? headers : [...headers, ...syntheticHeaders(width).slice(headers.length)];
  while (finalHeaders.length < width) finalHeaders.push(`列${finalHeaders.length + 1}`);

  const rows = normalizeRows(
    dataLines.map((line) => splitLine(line, delimiter)),
    width,
  );
  let commentDateIndex = findHeaderIndex(finalHeaders, COMMENT_DATE_RE);
  let collectTimeIndex = findHeaderIndex(finalHeaders, COLLECT_TIME_RE);
  // Prefer existing 实际发布时间 when source workbook already has it
  const actualPublishIndex = findHeaderIndex(finalHeaders, ACTUAL_PUBLISH_HEADER_RE);
  // Lock absolute publish column from header first (发布日期 / 发布时间)
  let timeColumnIndex =
    findHeaderIndex(finalHeaders, ABS_PUBLISH_RE) ??
    findAbsPublishIndex(finalHeaders, commentDateIndex, collectTimeIndex);

  // Detect likes before inferring comment (K/M must not be treated as relative time)
  let likeColumnIndex = findHeaderIndex(finalHeaders, LIKE_HEADER_RE);
  if (likeColumnIndex == null) {
    likeColumnIndex = inferLikeColumn(rows, width, [
      commentDateIndex,
      collectTimeIndex,
      timeColumnIndex,
      actualPublishIndex,
    ]);
  }

  const inferred = inferTimeColumns(
    rows,
    width,
    commentDateIndex,
    collectTimeIndex,
    timeColumnIndex,
    likeColumnIndex,
  );
  if (commentDateIndex == null) commentDateIndex = inferred.commentIdx;
  if (collectTimeIndex == null) collectTimeIndex = inferred.collectIdx;
  // Recompute abs index only if still missing (do not steal locked header)
  if (timeColumnIndex == null) {
    timeColumnIndex = findAbsPublishIndex(finalHeaders, commentDateIndex, collectTimeIndex);
  }

  return {
    headers: finalHeaders.slice(0, width),
    rows,
    delimiter,
    commentDateIndex,
    collectTimeIndex,
    timeColumnIndex,
    actualPublishIndex,
    likeColumnIndex,
    usedHeaderRow: useHeader,
  };
}

/** Cell looks like relative / month-day comment date (not a full year datetime). */
export function looksLikeCommentDateCell(raw: string): boolean {
  const s = `${raw ?? ''}`.trim();
  if (!s || s.length > 40) return false;
  if (parseRelativeAge(s) != null) return true;
  if (/^\d{1,2}\s*月\s*\d{1,2}\s*[日号號]?$/.test(s)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(s)) return true;
  // M-D / M/D without year (e.g. 9-18)
  if (/^\d{1,2}[\/\-]\d{1,2}$/.test(s)) return true;
  return false;
}

/**
 * Parse like counts: 4998, 71.4K, 2M, 1.2万, 3千…
 */
export function parseLikeCount(raw: string): number | null {
  let s = `${raw ?? ''}`.trim().replace(/,/g, '').replace(/\s+/g, '');
  if (!s) return null;
  // strip surrounding junk
  s = s.replace(/^[^\d]+/, '');
  if (!s) return null;

  const m = s.match(/^(\d+(?:\.\d+)?)([kKmM万萬千])?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'k') return Math.round(n * 1_000);
  if (unit === 'm') return Math.round(n * 1_000_000);
  if (unit === '万' || unit === '萬') return Math.round(n * 10_000);
  if (unit === '千') return Math.round(n * 1_000);
  return Math.round(n);
}

function looksLikeLikeCell(raw: string): boolean {
  const s = `${raw ?? ''}`.trim();
  if (!s || s.length > 24) return false;
  if (/https?:\/\//i.test(s)) return false;
  if (/[月日年]/.test(s)) return false;
  if (!parseLikeCount(s)) return false;
  // Strong signal: 71.4K / 2M / 1.2万
  if (/[kKmM万萬]/.test(s)) return true;
  // Plain integers: at least 3 digits, not a year
  if (/^\d{3,}$/.test(s.replace(/,/g, ''))) {
    const n = Number(s.replace(/,/g, ''));
    if (n >= 1900 && n <= 2100 && s.length === 4) return false;
    return n >= 100;
  }
  return false;
}

function inferLikeColumn(
  rows: string[][],
  width: number,
  exclude: Array<number | null>,
): number | null {
  const scores = new Array(width).fill(0);
  const kmHits = new Array(width).fill(0);
  const sample = rows.slice(0, Math.min(rows.length, 80));
  for (const row of sample) {
    for (let i = 0; i < width; i++) {
      if (exclude.includes(i)) continue;
      const cell = row[i] ?? '';
      if (!looksLikeLikeCell(cell)) continue;
      const strong = /[kKmM万萬]/.test(cell);
      scores[i] += strong ? 5 : 1;
      if (strong) kmHits[i]++;
    }
  }
  let bestIdx: number | null = null;
  let best = 0;
  for (let i = 0; i < width; i++) {
    // Prefer columns that contain at least one K/M/万 (engagement), not row IDs
    if (kmHits[i]! === 0 && scores[i]! > 0) {
      // plain-number-only columns need higher bar
      if (scores[i]! < sample.length * 0.8) continue;
    }
    if (scores[i]! > best) {
      best = scores[i]!;
      bestIdx = i;
    }
  }
  // Must have K/M evidence when available among columns
  const anyKm = kmHits.some((h) => h > 0);
  if (anyKm && bestIdx != null && kmHits[bestIdx]! === 0) {
    bestIdx = null;
    best = 0;
    for (let i = 0; i < width; i++) {
      if (kmHits[i]! === 0) continue;
      if (scores[i]! > best) {
        best = scores[i]!;
        bestIdx = i;
      }
    }
  }
  const minNeed = Math.max(3, Math.floor(sample.length * 0.3));
  return best >= minNeed ? bestIdx : null;
}

function resolveLikeCount(
  row: string[],
  table: Pick<TableData, 'likeColumnIndex' | 'headers'>,
): { count: number | null; raw: string } {
  if (table.likeColumnIndex != null) {
    const raw = `${row[table.likeColumnIndex] ?? ''}`.trim();
    return { count: parseLikeCount(raw), raw };
  }
  // scan cells for K/M style likes
  for (const cell of row) {
    const raw = `${cell ?? ''}`.trim();
    if (!looksLikeLikeCell(raw)) continue;
    // prefer values with K/M/万
    if (/[kKmM万萬]/.test(raw) || /^\d{2,}$/.test(raw.replace(/,/g, ''))) {
      const count = parseLikeCount(raw);
      if (count != null) return { count, raw };
    }
  }
  return { count: null, raw: '' };
}

/** Cell looks like absolute collection/publish datetime with year. */
export function looksLikeCollectTimeCell(raw: string): boolean {
  const s = `${raw ?? ''}`.trim();
  if (!s || /^#+$/.test(s)) return false;
  if (!/\d{4}/.test(s)) return false;
  if (parseAbsoluteTime(s) == null) return false;
  // Prefer datetimes (have time or clear date separators), skip plain years/ids
  if (/[\/\-年]/.test(s) || /:\d{2}/.test(s)) return true;
  return false;
}

function inferTimeColumns(
  rows: string[][],
  width: number,
  knownComment: number | null,
  knownCollect: number | null,
  knownAbsPublish: number | null = null,
  knownLike: number | null = null,
): { commentIdx: number | null; collectIdx: number | null } {
  if (knownComment != null && knownCollect != null) {
    return { commentIdx: knownComment, collectIdx: knownCollect };
  }
  const commentScores = new Array(width).fill(0);
  const collectScores = new Array(width).fill(0);
  const sample = rows.slice(0, Math.min(rows.length, 80));
  for (const row of sample) {
    for (let i = 0; i < width; i++) {
      // Never infer onto locked 发布日期 / 点赞数 columns
      if (knownAbsPublish != null && i === knownAbsPublish) continue;
      if (knownLike != null && i === knownLike) continue;
      const cell = row[i] ?? '';
      if (looksLikeCommentDateCell(cell)) commentScores[i]++;
      if (looksLikeCollectTimeCell(cell)) collectScores[i]++;
    }
  }
  const best = (scores: number[], exclude: Array<number | null>): number | null => {
    let idx: number | null = null;
    let bestScore = 0;
    for (let i = 0; i < scores.length; i++) {
      if (exclude.includes(i)) continue;
      if (scores[i]! > bestScore) {
        bestScore = scores[i]!;
        idx = i;
      }
    }
    const minNeed = Math.max(1, Math.floor(sample.length * 0.15));
    return bestScore >= minNeed ? idx : null;
  };
  const commentIdx =
    knownComment ?? best(commentScores, [knownCollect, knownAbsPublish, knownLike]);
  // Prefer 采集时间 = column that is mostly the SAME timestamp across rows
  // (avoids mistaking already-calculated 实际发布时间 for 采集时间)
  const collectIdx =
    knownCollect ??
    inferUniformCollectColumn(sample, width, [
      commentIdx,
      knownAbsPublish,
      knownLike,
      knownComment,
    ]) ??
    best(collectScores, [commentIdx, knownAbsPublish, knownLike]);
  return { commentIdx, collectIdx };
}

/** Pick datetime column with highest value uniformity (typical scrape time). */
function inferUniformCollectColumn(
  sample: string[][],
  width: number,
  exclude: Array<number | null>,
): number | null {
  let bestIdx: number | null = null;
  let bestScore = -1;
  for (let i = 0; i < width; i++) {
    if (exclude.includes(i)) continue;
    const vals: string[] = [];
    for (const row of sample) {
      const c = `${row[i] ?? ''}`.trim();
      // Need clock time — date-only is usually 发布日期
      if (looksLikeCollectTimeCell(c) && /\d{1,2}:\d{2}/.test(c)) vals.push(c);
    }
    if (vals.length < Math.max(2, Math.floor(sample.length * 0.4))) continue;
    const uniq = new Set(vals);
    const uniformity = vals.length / Math.max(1, uniq.size);
    const score = vals.length + uniformity * 20;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Pull comment/collect candidates from free text when columns are messy. */
function extractTimeTokensFromText(text: string): { comments: string[]; collects: string[] } {
  const comments: string[] = [];
  const collects: string[] = [];
  const absRe =
    /\d{4}\s*[\/\-年.]\s*\d{1,2}\s*[\/\-月.]\s*\d{1,2}\s*[日号號]?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g;
  const relRe =
    /\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|y|秒|分钟|分|小時|小时|时|天|週|周|月|年)\s*(?:ago|前)?|\d{1,2}\s*月\s*\d{1,2}\s*[日号號]?/gi;

  for (const m of text.match(absRe) ?? []) {
    if (looksLikeCollectTimeCell(m)) collects.push(m.trim());
  }
  for (const m of text.match(relRe) ?? []) {
    const t = m.trim();
    if (looksLikeCommentDateCell(t)) comments.push(t);
  }
  return { comments, collects };
}

export function parseKeywords(raw: string): string[] {
  return `${raw ?? ''}`
    .split(/[\n,，;；]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Excel serial date → Unix seconds (days since 1899-12-30). */
export function excelSerialToUnix(serial: number): number | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 120000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function ymdHmsToUnix(
  y: number,
  mo: number,
  d: number,
  hh = 0,
  mm = 0,
  ss = 0,
): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, hh, mm, ss);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.floor(dt.getTime() / 1000);
}

/**
 * Parse absolute datetime at any precision: year / month / day / hour / minute / second.
 * Examples: 2025、2025-6、2025/6/7、2025/6/7 11:47、2025年6月7日11时47分30秒
 */
export function parseAbsoluteTime(raw: string): number | null {
  const s = `${raw ?? ''}`.trim();
  if (!s || /^#+$/.test(s)) return null;
  if (/^\d{10}$/.test(s)) return Number(s);
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // plain year
    if (/^\d{4}$/.test(s)) return ymdHmsToUnix(n, 1, 1, 0, 0, 0);
    const fromExcel = excelSerialToUnix(n);
    if (fromExcel != null) return fromExcel;
  }

  // 2025年6月7日11时47分30秒 / 2025年6月7日
  let cn = s.match(
    /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:(\d{1,2})\s*[时時:：点點]\s*(\d{1,2})\s*分?(?:\s*(\d{1,2})\s*秒?)?)?$/,
  );
  if (cn) {
    return ymdHmsToUnix(
      Number(cn[1]),
      Number(cn[2]),
      Number(cn[3]),
      cn[4] != null ? Number(cn[4]) : 0,
      cn[5] != null ? Number(cn[5]) : 0,
      cn[6] != null ? Number(cn[6]) : 0,
    );
  }
  // 2025年6月
  cn = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月$/);
  if (cn) return ymdHmsToUnix(Number(cn[1]), Number(cn[2]), 1, 0, 0, 0);
  // 2025年
  cn = s.match(/^(\d{4})\s*年$/);
  if (cn) return ymdHmsToUnix(Number(cn[1]), 1, 1, 0, 0, 0);

  const normalized = s
    .replace(/[年/\.]/g, '-')
    .replace(/[月]/g, '-')
    .replace(/[日]/g, '')
    .replace(/[时時]/g, ':')
    .replace(/分/g, ':')
    .replace(/秒/g, '')
    .replace(/T/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/:+/g, ':')
    .replace(/:\s*$/g, '')
    .trim();

  // YYYY-M-D[ H:M[:S]]
  let m = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/,
  );
  if (m) {
    return ymdHmsToUnix(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      m[4] != null ? Number(m[4]) : 0,
      m[5] != null ? Number(m[5]) : 0,
      m[6] != null ? Number(m[6]) : 0,
    );
  }
  // YYYY-M
  m = normalized.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return ymdHmsToUnix(Number(m[1]), Number(m[2]), 1, 0, 0, 0);

  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  return null;
}

/** @deprecated use parseAbsoluteTime */
export const parsePublishTime = parseAbsoluteTime;

type CalendarUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

function normalizeUnit(unitRaw: string): CalendarUnit | null {
  const unit = unitRaw.toLowerCase();
  if (/^(s|sec|secs|second|seconds|秒)$/.test(unit)) return 'second';
  if (/^(m|min|mins|minute|minutes|分|分钟)$/.test(unit)) return 'minute';
  if (/^(h|hr|hrs|hour|hours|时|小时|小時)$/.test(unit)) return 'hour';
  if (/^(d|day|days|天)$/.test(unit)) return 'day';
  if (/^(w|week|weeks|周|週)$/.test(unit)) return 'week';
  if (/^(mo|mon|month|months|月)$/.test(unit)) return 'month';
  if (/^(y|yr|yrs|year|years|年)$/.test(unit)) return 'year';
  return null;
}

/** Calendar-aware subtract from collect timestamp (年/月按日历，其余按时长). */
export function subtractFromCollect(
  collectSec: number,
  amount: number,
  unit: CalendarUnit,
): number {
  const d = new Date(collectSec * 1000);
  const n = Math.round(amount);
  switch (unit) {
    case 'year':
      d.setFullYear(d.getFullYear() - n);
      break;
    case 'month':
      d.setMonth(d.getMonth() - n);
      break;
    case 'week':
      d.setDate(d.getDate() - n * 7);
      break;
    case 'day':
      d.setDate(d.getDate() - n);
      break;
    case 'hour':
      d.setHours(d.getHours() - n);
      break;
    case 'minute':
      d.setMinutes(d.getMinutes() - n);
      break;
    case 'second':
      d.setSeconds(d.getSeconds() - n);
      break;
  }
  return Math.floor(d.getTime() / 1000);
}

/**
 * Parse relative age → { amount, unit } for 年/月/周/天/时/分/秒.
 * Supports: 2h ago, 30s ago, 3 months ago, 2小时前, 30秒前, 3个月前, 1年前…
 */
export function parseRelativeAge(
  raw: string,
): { amount: number; unit: CalendarUnit } | null {
  const s = `${raw ?? ''}`.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^(just\s*now|now|刚刚|剛才|刚才)$/i.test(s)) {
    return { amount: 0, unit: 'second' };
  }

  // Single-letter units MUST include "ago" (avoid treating 2M likes as 2 minutes)
  let m = s.match(
    /^(\d+(?:\.\d+)?)\s*([smhdwy])\s+ago$/i,
  );
  if (!m) {
    // 2 hours ago / 3 months ago / 1 year ago (word form; ago optional)
    m = s.match(
      /^(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|mons?|mo|years?|yrs?)\s*(ago)?$/i,
    );
  }
  if (!m) {
    // 2小时前 / 30秒前 / 3个月前 / 1年前 / 5天前 / 10分钟前
    m = s.match(
      /^(\d+(?:\.\d+)?)\s*个?\s*(秒|分钟|分|小時|小时|时|天|週|周|月|年)\s*前$/,
    );
  }
  if (!m) return null;

  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = normalizeUnit(m[2] ?? '');
  if (!unit) return null;
  return { amount, unit };
}

/** @deprecated prefer parseRelativeAge + subtractFromCollect */
export function parseRelativeOffsetSec(raw: string): number | null {
  const age = parseRelativeAge(raw);
  if (!age) return null;
  const approx: Record<CalendarUnit, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 7 * 86400,
    month: 30 * 86400,
    year: 365 * 86400,
  };
  return Math.round(age.amount * approx[age.unit]);
}

/**
 * 「9月9日」「9月9号」「Sep 9」→ 以采集年份拼日期；若结果晚于采集时间则回退一年。
 * 时刻沿用采集时间的时分秒。
 */
export function parseMonthDayAgainstCollect(
  commentRaw: string,
  collectSec: number,
): number | null {
  const s = `${commentRaw ?? ''}`.trim();
  if (!s) return null;

  let month = 0;
  let day = 0;
  let m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?$/);
  if (m) {
    month = Number(m[1]);
    day = Number(m[2]);
  } else {
    m = s.match(/^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
    if (m) {
      const map: Record<string, number> = {
        jan: 1,
        january: 1,
        feb: 2,
        february: 2,
        mar: 3,
        march: 3,
        apr: 4,
        april: 4,
        may: 5,
        jun: 6,
        june: 6,
        jul: 7,
        july: 7,
        aug: 8,
        august: 8,
        sep: 9,
        sept: 9,
        september: 9,
        oct: 10,
        october: 10,
        nov: 11,
        november: 11,
        dec: 12,
        december: 12,
      };
      month = map[(m[1] ?? '').toLowerCase()] ?? 0;
      day = Number(m[2]);
    } else {
      m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
      if (!m) return null;
      month = Number(m[1]);
      day = Number(m[2]);
      // Ambiguous M/D vs D/M: prefer M/D when month<=12
      if (month > 12 && day <= 12) {
        const tmp = month;
        month = day;
        day = tmp;
      }
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const collect = new Date(collectSec * 1000);
  let y = collect.getFullYear();
  const candidate = new Date(
    y,
    month - 1,
    day,
    collect.getHours(),
    collect.getMinutes(),
    collect.getSeconds(),
  );
  if (Number.isNaN(candidate.getTime())) return null;
  if (candidate.getTime() > collect.getTime()) {
    candidate.setFullYear(y - 1);
  }
  if (Number.isNaN(candidate.getTime()) || candidate.getTime() > collect.getTime()) {
    return null;
  }
  return Math.floor(candidate.getTime() / 1000);
}

/**
 * From 评论日期 + 采集时间 → 实际发布时间 Unix 秒。
 * 支持：相对时长（年/月/天/小时/分）、「9月9日」、完整绝对时间。
 */
export function commentDateToActualSec(
  commentRaw: string,
  collectSec: number,
): number | null {
  const comment = `${commentRaw ?? ''}`.trim();
  if (!comment) return null;

  const age = parseRelativeAge(comment);
  if (age) {
    return subtractFromCollect(collectSec, age.amount, age.unit);
  }

  const md = parseMonthDayAgainstCollect(comment, collectSec);
  if (md != null) return md;

  // 完整日期：2026年9月9日 / 2026-09-09 / 2026/9/9
  const abs = parseAbsoluteTime(comment);
  if (abs != null) return abs;

  const cn = comment.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?/);
  if (cn) {
    const collect = new Date(collectSec * 1000);
    const dt = new Date(
      Number(cn[1]),
      Number(cn[2]) - 1,
      Number(cn[3]),
      collect.getHours(),
      collect.getMinutes(),
      collect.getSeconds(),
    );
    if (!Number.isNaN(dt.getTime())) return Math.floor(dt.getTime() / 1000);
  }

  return null;
}

function rowHaystack(row: string[]): string {
  return row.join(' ').toLowerCase();
}

function explainFormula(commentRaw: string, collectRaw: string, actualSec: number): string {
  return `采集「${collectRaw}」+ 发布「${commentRaw}」→ 实际发布 **${formatPublishDisplay(actualSec)}**`;
}

function explainAbsolute(label: string, raw: string, actualSec: number): string {
  return `使用${label}「${raw}」→ 实际发布 **${formatPublishDisplay(actualSec)}**`;
}

/**
 * 实际发布时间推算（自动适配）：
 * 0) 源表已有「实际发布时间」列时优先直接用
 * 1) 发布日期/时间（绝对，任意到年/月/日/时/分/秒）
 * 2) 采集时间 + 评论相对时长（年/月/天/时/分/秒）或 9月9日
 * 3) 行内扫描 / 正则
 */
export function resolveActualPublishSec(
  row: string[],
  table: Pick<
    TableData,
    'commentDateIndex' | 'collectTimeIndex' | 'timeColumnIndex' | 'actualPublishIndex' | 'headers'
  >,
): ResolvePublishResult {
  const empty = (explain: string): ResolvePublishResult => ({
    sec: null,
    fromCollectComment: false,
    explain,
    commentRaw: '',
    collectRaw: '',
  });

  const tryPair = (commentRaw: string, collectRaw: string): ResolvePublishResult | null => {
    const collect = parseAbsoluteTime(collectRaw);
    if (collect == null) return null;
    const actual = commentDateToActualSec(commentRaw, collect);
    if (actual == null) return null;
    // If comment was already an absolute date, still mark as computed from fields
    const rel = parseRelativeAge(commentRaw) != null || looksLikeCommentDateCell(commentRaw);
    return {
      sec: actual,
      fromCollectComment: rel || parseAbsoluteTime(commentRaw) != null,
      explain: explainFormula(commentRaw, collectRaw, actual),
      commentRaw,
      collectRaw,
    };
  };

  const tryAbsoluteRaw = (raw: string, label: string): ResolvePublishResult | null => {
    const abs = parseAbsoluteTime(raw);
    if (abs == null) return null;
    return {
      sec: abs,
      fromCollectComment: true,
      explain: explainAbsolute(label, raw, abs),
      commentRaw: raw,
      collectRaw: '',
    };
  };

  // 0) 源表已有「实际发布时间」→ 直接按该列筛（与导出列一致）
  if (table.actualPublishIndex != null) {
    const raw = `${row[table.actualPublishIndex] ?? ''}`.trim();
    const hit = tryAbsoluteRaw(raw, table.headers[table.actualPublishIndex] || COL_ACTUAL_PUBLISH);
    if (hit) return hit;
  }

  // 1) 发布日期 / 发布时间 column — absolute (2025/6/7) or relative (30秒前) with 采集时间
  if (table.timeColumnIndex != null) {
    const raw = `${row[table.timeColumnIndex] ?? ''}`.trim();
    const label = table.headers[table.timeColumnIndex] || '发布日期';
    if (table.collectTimeIndex != null) {
      const paired = tryPair(raw, row[table.collectTimeIndex] ?? '');
      if (paired) return paired;
    }
    const hit = tryAbsoluteRaw(raw, label);
    if (hit) return hit;
  }

  // 2) 评论日期 + 采集时间（相对年/月/日/时/分/秒，或绝对日期）
  if (table.collectTimeIndex != null && table.commentDateIndex != null) {
    const hit = tryPair(
      row[table.commentDateIndex] ?? '',
      row[table.collectTimeIndex] ?? '',
    );
    if (hit) return hit;
  }

  // 3) 评论/发布列本身是绝对日期（无采集也可）
  if (table.commentDateIndex != null) {
    const raw = `${row[table.commentDateIndex] ?? ''}`.trim();
    if (!looksLikeCommentDateCell(raw) || parseAbsoluteTime(raw) != null) {
      const hit = tryAbsoluteRaw(raw, table.headers[table.commentDateIndex] || '评论/发布日期');
      // only if absolute (not pure relative without collect)
      if (hit && parseAbsoluteTime(raw) != null && parseRelativeAge(raw) == null) return hit;
    }
  }

  // 4) Scan cells
  const commentCells: string[] = [];
  const collectCells: string[] = [];
  const absoluteCells: string[] = [];
  for (let i = 0; i < row.length; i++) {
    if (table.collectTimeIndex === i) {
      const t = `${row[i] ?? ''}`.trim();
      if (t) collectCells.push(t);
      continue;
    }
    const cell = `${row[i] ?? ''}`.trim();
    if (!cell) continue;
    if (looksLikeCommentDateCell(cell)) commentCells.push(cell);
    if (looksLikeCollectTimeCell(cell)) collectCells.push(cell);
    if (parseAbsoluteTime(cell) != null && /\d{4}/.test(cell)) absoluteCells.push(cell);
  }
  for (const c of commentCells) {
    for (const t of collectCells) {
      const hit = tryPair(c, t);
      if (hit) return hit;
    }
  }

  // Prefer absolute date cell that is not the collect timestamp
  const collectSet = new Set(collectCells.map((c) => c.trim()));
  for (const abs of absoluteCells) {
    if (collectSet.has(abs)) continue;
    // skip if equals collect time string
    const hit = tryAbsoluteRaw(abs, '发布日期');
    if (hit) return hit;
  }

  // 5) Regex on joined row text
  const tokens = extractTimeTokensFromText(row.join(' '));
  for (const c of tokens.comments) {
    for (const t of tokens.collects) {
      const hit = tryPair(c, t);
      if (hit) return hit;
    }
  }
  for (const t of tokens.collects) {
    // also try absolute tokens that look like date-only publish
  }
  for (const m of row.join(' ').match(
    /\d{4}\s*[\/\-年.]\s*\d{1,2}\s*[\/\-月.]\s*\d{1,2}\s*[日号號]?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g,
  ) ?? []) {
    const raw = m.trim();
    if (collectSet.has(raw)) continue;
    if (tokens.collects.includes(raw)) continue;
    const hit = tryAbsoluteRaw(raw, '发布日期');
    if (hit) return hit;
  }

  // 6) Collect time only (last resort)
  const collectOnly =
    (table.collectTimeIndex != null ? row[table.collectTimeIndex] : '') ||
    collectCells[0] ||
    tokens.collects[0] ||
    '';
  if (collectOnly) {
    const collect = parseAbsoluteTime(collectOnly);
    if (collect != null) {
      return {
        sec: collect,
        fromCollectComment: false,
        explain: `仅识别到采集时间「${collectOnly}」，无发布/评论日期 → 暂用 **${formatPublishDisplay(collect)}**`,
        commentRaw: '',
        collectRaw: collectOnly,
      };
    }
  }

  return empty('未能从该行识别发布日期 / 评论日期与采集时间');
}

function detectNoteFor(table: TableData): string {
  const parts: string[] = [];
  if (table.actualPublishIndex != null) {
    parts.push(
      `实际发布时间列=「${table.headers[table.actualPublishIndex]}」(#${table.actualPublishIndex + 1}，优先)`,
    );
  }
  if (table.timeColumnIndex != null) {
    parts.push(
      `发布日期列=「${table.headers[table.timeColumnIndex]}」(#${table.timeColumnIndex + 1})`,
    );
  }
  if (table.commentDateIndex != null) {
    parts.push(`评论日期列=「${table.headers[table.commentDateIndex]}」(#${table.commentDateIndex + 1})`);
  } else if (table.timeColumnIndex == null && table.actualPublishIndex == null) {
    parts.push('评论/发布日期=自动扫描');
  }
  if (table.collectTimeIndex != null) {
    parts.push(`采集时间列=「${table.headers[table.collectTimeIndex]}」(#${table.collectTimeIndex + 1})`);
  } else {
    parts.push('采集时间列=自动扫描');
  }
  if (table.likeColumnIndex != null) {
    parts.push(`点赞数列=「${table.headers[table.likeColumnIndex]}」(#${table.likeColumnIndex + 1})`);
  } else {
    parts.push('点赞数列=自动扫描');
  }
  parts.push('精度：年/月/日/时/分/秒；有实际发布时间列则优先；点赞支持 K/M/万');
  return parts.join('；');
}

export function filterRows(table: TableData, opts: FilterOptions): FilterResult {
  const keywords = opts.keywords.map((k) => k.toLowerCase());
  const hasTimeRange =
    (opts.publishStartSec != null && Number.isFinite(opts.publishStartSec)) ||
    (opts.publishEndSec != null && Number.isFinite(opts.publishEndSec));
  const hasLikeRange =
    (opts.likeMin != null && Number.isFinite(opts.likeMin)) ||
    (opts.likeMax != null && Number.isFinite(opts.likeMax));

  if (keywords.length === 0 && !hasTimeRange && !hasLikeRange) {
    throw new Error('请至少填写关键词、发布时间范围或点赞数范围之一');
  }

  // Keep original columns; only append 实际发布时间 (match source workbook style)
  const outHeaders = [...table.headers];
  if (!outHeaders.includes(COL_ACTUAL_PUBLISH)) {
    outHeaders.push(COL_ACTUAL_PUBLISH);
  }
  const actualIdx = outHeaders.indexOf(COL_ACTUAL_PUBLISH);

  const matched: string[][] = [];
  let skippedOutOfRange = 0;
  let skippedNoTime = 0;
  let skippedOutOfLike = 0;
  let skippedNoLike = 0;
  let timeFilterApplied = false;
  let likeFilterApplied = false;
  let usedCollectCommentFormula = false;
  const explainSamples: string[] = [];

  for (const row of table.rows) {
    if (keywords.length > 0) {
      const hay = rowHaystack(row);
      if (!keywords.some((k) => hay.includes(k))) continue;
    }

    const resolved = resolveActualPublishSec(row, table);
    if (resolved.fromCollectComment) usedCollectCommentFormula = true;

    if (hasTimeRange) {
      if (resolved.sec == null) {
        skippedNoTime++;
        continue;
      }
      timeFilterApplied = true;
      if (opts.publishStartSec != null && resolved.sec < opts.publishStartSec) {
        skippedOutOfRange++;
        continue;
      }
      if (opts.publishEndSec != null && resolved.sec > opts.publishEndSec) {
        skippedOutOfRange++;
        continue;
      }
    }

    const like = resolveLikeCount(row, table);
    if (hasLikeRange) {
      likeFilterApplied = true;
      if (like.count == null) {
        skippedNoLike++;
        continue;
      }
      if (opts.likeMin != null && like.count < opts.likeMin) {
        skippedOutOfLike++;
        continue;
      }
      if (opts.likeMax != null && like.count > opts.likeMax) {
        skippedOutOfLike++;
        continue;
      }
    }

    const outRow = [...row];
    while (outRow.length < outHeaders.length) outRow.push('');
    outRow[actualIdx] = resolved.sec != null ? formatPublishDisplay(resolved.sec) : '';
    matched.push(outRow.slice(0, outHeaders.length));
    if (explainSamples.length < 8 && resolved.explain) {
      explainSamples.push(resolved.explain);
    }
  }

  return {
    headers: outHeaders,
    matched,
    totalRows: table.rows.length,
    skippedOutOfRange,
    skippedNoTime,
    skippedOutOfLike,
    skippedNoLike,
    timeFilterApplied,
    likeFilterApplied,
    usedCollectCommentFormula,
    detectNote: detectNoteFor(table),
    explainSamples,
  };
}

export function escapeCsvCell(value: string): string {
  const s = `${value ?? ''}`;
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((r) => headers.map((_, i) => escapeCsvCell(r[i] ?? '')).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

/** Export with same delimiter family as source (tab stays tab so Excel paste matches). */
export function toTableText(
  headers: string[],
  rows: string[][],
  delimiter: string,
): string {
  const sep = delimiter === '\t' || delimiter === ' multispace' ? '\t' : ',';
  if (sep === '\t') {
    const esc = (v: string) => `${v ?? ''}`.replace(/\t|\r?\n/g, ' ');
    const lines = [
      headers.map(esc).join('\t'),
      ...rows.map((r) => headers.map((_, i) => esc(r[i] ?? '')).join('\t')),
    ];
    return `${lines.join('\n')}\n`;
  }
  return toCsv(headers, rows);
}

/** ISO-like with dashes (for logs / range labels). */
export function formatUnix(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Match common spreadsheet display in source data:
 * `2026/9/18 16:04` or `2024/1/12 0:00` (no leading zero on M/D/H; omit seconds when 0).
 */
export function formatPublishDisplay(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = d.getHours();
  const mm = d.getMinutes();
  const ss = d.getSeconds();
  const time =
    ss === 0
      ? `${hh}:${`${mm}`.padStart(2, '0')}`
      : `${hh}:${`${mm}`.padStart(2, '0')}:${`${ss}`.padStart(2, '0')}`;
  return `${y}/${m}/${day} ${time}`;
}

export function buildPreviewMarkdown(
  headers: string[],
  rows: string[][],
  limit = 10,
): string {
  const show = rows.slice(0, limit);
  if (show.length === 0) return '_（无命中行）_';

  // Put computed time columns first so wide tables stay readable
  const prefer = [
    COL_ACTUAL_PUBLISH,
    '点赞数',
    '发布日期',
    '采集时间',
    '文案',
    '视频链接',
    '内容',
  ];
  const order: number[] = [];
  for (const name of prefer) {
    const i = headers.indexOf(name);
    if (i >= 0 && !order.includes(i)) order.push(i);
  }
  for (let i = 0; i < headers.length; i++) {
    if (!order.includes(i)) order.push(i);
  }
  // Cap preview width
  const cols = order.slice(0, 8);
  const labels = cols.map((i) => headers[i]!);
  const head = `| ${labels.join(' | ')} |`;
  const sep = `| ${labels.map(() => '---').join(' | ')} |`;
  const body = show.map(
    (r) =>
      `| ${cols.map((i) => `${r[i] ?? ''}`.replace(/\|/g, '\\|')).join(' | ')} |`,
  );
  const more =
    rows.length > limit ? `\n\n… 另有 ${rows.length - limit} 行，见导出文件。` : '';
  return [head, sep, ...body].join('\n') + more;
}
