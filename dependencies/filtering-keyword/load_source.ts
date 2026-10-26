/**
 * Load a local file (text / spreadsheet) into plain tabular text.
 */
import { extname } from 'node:path';
import * as XLSX from 'xlsx';
import { excelSerialToUnix, formatPublishDisplay } from './filter_rows';

const SPREADSHEET_EXT = new Set([
  '.xlsx',
  '.xls',
  '.xlsm',
  '.xlsb',
  '.ods',
  '.csv', // SheetJS also reads csv reliably with encoding
]);

const TEXT_EXT = new Set([
  '.txt',
  '.tsv',
  '.md',
  '.log',
  '.json',
  '.html',
  '.htm',
  '.xml',
]);

function cellToString(c: unknown): string {
  if (c == null || c === '') return '';
  if (c instanceof Date) {
    return formatPublishDisplay(Math.floor(c.getTime() / 1000));
  }
  if (typeof c === 'number') {
    const excel = excelSerialToUnix(c);
    if (excel != null) return formatPublishDisplay(excel);
    return `${c}`;
  }
  return `${c}`.replace(/[\t\r\n]+/g, ' ');
}

function spreadsheetBufferToTsv(buf: ArrayBuffer | Uint8Array): string {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: false });
  if (!wb.SheetNames.length) {
    throw new Error('表格文件没有工作表');
  }
  const name = wb.SheetNames[0]!;
  const sheet = wb.Sheets[name];
  if (!sheet) {
    throw new Error(`无法读取工作表：${name}`);
  }
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  }) as unknown[][];
  if (!aoa.length) {
    throw new Error('工作表为空');
  }
  return aoa
    .map((row) => (Array.isArray(row) ? row : []).map(cellToString).join('\t'))
    .join('\n');
}

async function readSpreadsheetFile(filePath: string): Promise<string> {
  const f = Bun.file(filePath);
  const buf = await f.arrayBuffer();
  return spreadsheetBufferToTsv(buf);
}

async function readTextFile(filePath: string): Promise<string> {
  const text = await Bun.file(filePath).text();
  if (!text.trim()) {
    throw new Error('文件内容为空');
  }
  // JSON array of objects → TSV
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(data) ? data : [data];
      if (rows.length && typeof rows[0] === 'object' && rows[0] != null) {
        const headers = Object.keys(rows[0] as Record<string, unknown>);
        const lines = [
          headers.join('\t'),
          ...rows.map((row) =>
            headers
              .map((h) => `${(row as Record<string, unknown>)[h] ?? ''}`.replace(/\t|\n/g, ' '))
              .join('\t'),
          ),
        ];
        return lines.join('\n');
      }
    } catch {
      // fall through: treat as plain text
    }
  }
  return text;
}

/**
 * Read a local file into text the filter parser understands.
 * Spreadsheets (xlsx/xls/…) → first sheet as TSV; other files → UTF-8 text (JSON objects supported).
 */
export async function readFileAsTableText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.csv') {
    // Prefer SheetJS for encoding / Excel-exported CSV quirks; fallback to raw text
    try {
      return await readSpreadsheetFile(filePath);
    } catch {
      return await readTextFile(filePath);
    }
  }

  if (SPREADSHEET_EXT.has(ext) || ['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'].includes(ext)) {
    return await readSpreadsheetFile(filePath);
  }

  if (TEXT_EXT.has(ext) || ext === '.tsv' || ext === '') {
    return await readTextFile(filePath);
  }

  // Unknown extension: try spreadsheet first, then text
  try {
    return await readSpreadsheetFile(filePath);
  } catch {
    return await readTextFile(filePath);
  }
}

export async function loadSourceText(input: {
  sourceFile?: string;
}): Promise<{ text: string; sourceLabel: string }> {
  const filePath = `${input.sourceFile ?? ''}`.trim();
  if (!filePath) {
    throw new Error('请选择数据文件');
  }
  const f = Bun.file(filePath);
  if (!(await f.exists())) {
    throw new Error(`文件不存在：${filePath}`);
  }
  const text = await readFileAsTableText(filePath);
  return { text, sourceLabel: filePath };
}
