/**
 * Normalize headers to the original task-export schema and write .xlsx.
 */
import * as XLSX from 'xlsx';
import type { TableData } from './filter_rows';

/** Canonical headers from the original automation export (second screenshot). */
export const STANDARD_HEADERS = [
  'ID',
  '任务组 ID',
  '任务 ID',
  '设备 ID',
  '设备类型',
  '视频链接',
  '文案',
  '发布日期',
  '点赞数',
  '采集时间',
] as const;

export function isGarbledHeader(h: string): boolean {
  const s = `${h ?? ''}`.trim();
  if (!s) return true;
  if (/^列\d+$/.test(s)) return true;
  if (/�/.test(s)) return true;
  // mojibake / wrong-codepage leftovers
  if (/[ÃÂåæçéèøñ]|Ã.|Â./.test(s) && !/[\u4e00-\u9fff]/.test(s)) return true;
  // random high-bit latin without Chinese (common when UTF-8 read as Latin-1)
  const weird = (s.match(/[^\x20-\x7e\u4e00-\u9fffA-Za-z0-9_\-\s]/g) ?? []).length;
  if (weird >= 2 && !/[\u4e00-\u9fff]/.test(s) && !/^(ID|URL)$/i.test(s)) return true;
  return false;
}

function shouldReplace(current: string, standard: string): boolean {
  if (current === standard) return false;
  if (isGarbledHeader(current)) return true;
  if (/^列\d+$/.test(current) || !current.trim()) return true;
  // placeholder / truncated headers from bad encoding
  if (current.length <= 2 && !/^(ID)$/i.test(current)) return true;
  // already a different known good Chinese header — don't overwrite
  if (
    STANDARD_HEADERS.includes(current as (typeof STANDARD_HEADERS)[number]) ||
    current === '实际发布时间'
  ) {
    return false;
  }
  return false;
}

/**
 * Rename detected / garbled headers to match the original file column names.
 * Keeps extra columns; only fixes known roles.
 */
export function normalizeHeadersForExport(
  table: Pick<
    TableData,
    | 'headers'
    | 'rows'
    | 'commentDateIndex'
    | 'collectTimeIndex'
    | 'timeColumnIndex'
    | 'likeColumnIndex'
  >,
  headers: string[],
): string[] {
  const out = [...headers];
  const sample = table.rows.slice(0, Math.min(60, table.rows.length));

  const publishIdx = table.timeColumnIndex ?? table.commentDateIndex;
  if (publishIdx != null && shouldReplace(out[publishIdx] ?? '', '发布日期')) {
    out[publishIdx] = '发布日期';
  }
  if (table.collectTimeIndex != null && shouldReplace(out[table.collectTimeIndex] ?? '', '采集时间')) {
    out[table.collectTimeIndex] = '采集时间';
  }
  if (table.likeColumnIndex != null && shouldReplace(out[table.likeColumnIndex] ?? '', '点赞数')) {
    out[table.likeColumnIndex] = '点赞数';
  }

  for (let i = 0; i < out.length; i++) {
    const urlHits = sample.filter((r) => /^https?:\/\//i.test(`${r[i] ?? ''}`.trim())).length;
    if (urlHits >= Math.max(1, Math.floor(sample.length * 0.4))) {
      if (shouldReplace(out[i] ?? '', '视频链接')) out[i] = '视频链接';
    }
  }

  for (let i = 0; i < out.length; i++) {
    const typeHits = sample.filter((r) =>
      /浏览器|Android|iOS|手机|模拟器/i.test(`${r[i] ?? ''}`.trim()),
    ).length;
    if (typeHits >= Math.max(1, Math.floor(sample.length * 0.4))) {
      if (shouldReplace(out[i] ?? '', '设备类型')) out[i] = '设备类型';
    }
  }

  // 文案: long text column that is not URL / date / likes
  let copyIdx = -1;
  let copyScore = 0;
  for (let i = 0; i < out.length; i++) {
    if (
      i === publishIdx ||
      i === table.collectTimeIndex ||
      i === table.likeColumnIndex ||
      out[i] === '视频链接' ||
      out[i] === '设备类型'
    ) {
      continue;
    }
    let score = 0;
    for (const r of sample) {
      const c = `${r[i] ?? ''}`.trim();
      if (c.length >= 8 && !/^https?:\/\//i.test(c) && !/^\d+(\.\d+)?[kKmM万]?$/.test(c)) {
        score++;
      }
    }
    if (score > copyScore) {
      copyScore = score;
      copyIdx = i;
    }
  }
  if (copyIdx >= 0 && copyScore >= Math.max(1, Math.floor(sample.length * 0.3))) {
    if (shouldReplace(out[copyIdx] ?? '', '文案')) out[copyIdx] = '文案';
  }

  // Positional fallback when many headers look broken and width matches the standard export
  const broken = out
    .slice(0, 10)
    .filter(
      (h) =>
        isGarbledHeader(h) ||
        /^列\d+$/.test(h) ||
        !`${h}`.trim() ||
        (`${h}`.length <= 2 && !/^(ID)$/i.test(h)),
    ).length;
  if (broken >= 4 && out.length >= 10) {
    for (let i = 0; i < Math.min(STANDARD_HEADERS.length, out.length); i++) {
      const cur = out[i] ?? '';
      const std = STANDARD_HEADERS[i]!;
      if (
        isGarbledHeader(cur) ||
        /^列\d+$/.test(cur) ||
        !cur.trim() ||
        (cur.length <= 2 && !/^(ID)$/i.test(cur)) ||
        !STANDARD_HEADERS.includes(cur as (typeof STANDARD_HEADERS)[number])
      ) {
        // don't clobber roles we already fixed by content
        if (
          cur === '视频链接' ||
          cur === '文案' ||
          cur === '设备类型' ||
          cur === '发布日期' ||
          cur === '点赞数' ||
          cur === '采集时间' ||
          cur === '实际发布时间'
        ) {
          continue;
        }
        out[i] = std;
      }
    }
  }

  // First numeric id column → ID
  if (out.length > 0 && shouldReplace(out[0] ?? '', 'ID')) {
    const idHits = sample.filter((r) => /^\d+$/.test(`${r[0] ?? ''}`.trim())).length;
    if (idHits >= Math.max(1, Math.floor(sample.length * 0.6))) out[0] = 'ID';
  }

  return out;
}

/** Write filtered result as .xlsx (primary deliverable). */
export function writeXlsxFile(
  filePath: string,
  headers: string[],
  rows: string[][],
  sheetName = '筛选结果',
): void {
  const aoa: (string | number)[][] = [
    headers,
    ...rows.map((r) =>
      headers.map((_, i) => {
        const v = r[i] ?? '';
        // keep numeric like-count cells as numbers when plain digits
        if (/^\d+$/.test(v)) return Number(v);
        return v;
      }),
    ),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // rough column widths
  ws['!cols'] = headers.map((h) => ({
    wch: Math.min(40, Math.max(10, [...`${h}`].length + 4)),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filePath);
}
