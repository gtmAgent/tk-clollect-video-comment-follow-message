/**
 * 按关键词 / 实际发布时间 / 点赞数筛选任意格式文本/表格，预览并导出 CSV。
 */
import { join } from 'node:path';
import type { TaskRunConfig } from './config.types';
import {
  buildPreviewMarkdown,
  filterRows,
  formatUnix,
  parseKeywords,
  parseTableText,
} from './filter_rows';
import { normalizeHeadersForExport, writeXlsxFile } from './export_xlsx';
import { loadSourceText } from './load_source';
import {
  type AutomationRunResult,
  loadAutomationManifest,
  loadTaskRunConfig,
  XportContentClient,
} from 'xport-content-sdk';

function optionalUnix(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Like bounds: blank / 0 / NaN → unset (skip like filter; keyword-only OK). */
function optionalLikeBound(v: unknown): number | null {
  if (v == null || `${v}`.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function runContentTask(
  client: XportContentClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  let publishStart = optionalUnix(taskConfig.publishStart);
  let publishEnd = optionalUnix(taskConfig.publishEnd);
  // 单边留空自动适配：止空→当前时刻；起空→不限起点（筛到止）
  const endAdaptedFromBlank = publishStart != null && publishEnd == null;
  const startAdaptedFromBlank = publishEnd != null && publishStart == null;
  if (endAdaptedFromBlank) {
    publishEnd = Math.floor(Date.now() / 1000);
  }
  if (publishStart != null && publishEnd != null && publishStart > publishEnd) {
    return {
      succ: false,
      msg: '发布时间起不能晚于止',
      data: { matchCount: 0, resultFile: '', summary: '时间范围无效。' },
    };
  }

  const likeMin = optionalLikeBound(taskConfig.likeMin);
  const likeMax = optionalLikeBound(taskConfig.likeMax);
  if (likeMin != null && likeMax != null && likeMin > likeMax) {
    return {
      succ: false,
      msg: '点赞最小值不能大于最大值',
      data: { matchCount: 0, resultFile: '', summary: '点赞数范围无效。' },
    };
  }

  const outputDir = `${taskConfig.outputDir ?? ''}`.trim();
  if (!outputDir) {
    return {
      succ: false,
      msg: '请选择导出目录',
      data: { matchCount: 0, resultFile: '', summary: '未设置导出目录。' },
    };
  }

  const keywords = parseKeywords(taskConfig.keywords ?? '');
  const hasTime = publishStart != null || publishEnd != null;
  const hasLike = likeMin != null || likeMax != null;
  if (keywords.length === 0 && !hasTime && !hasLike) {
    return {
      succ: false,
      msg: '请填写关键词、发布时间或点赞数范围至少一项',
      data: {
        matchCount: 0,
        resultFile: '',
        summary: '可只按关键词、时间或点赞热度筛选，至少设置一项。',
      },
    };
  }

  let sourceLabel = '';
  try {
    const loaded = await loadSourceText({
      sourceFile: taskConfig.sourceFile,
    });
    sourceLabel = loaded.sourceLabel;
    const table = parseTableText(loaded.text);
    client.taskLog(
      `source=${sourceLabel} rows=${table.rows.length} keywords=${keywords.length} likeCol=${table.likeColumnIndex} like=${likeMin ?? '-'}~${likeMax ?? '-'}`,
    );

    const filtered = filterRows(table, {
      keywords,
      publishStartSec: publishStart,
      publishEndSec: publishEnd,
      likeMin,
      likeMax,
    });

    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const exportHeaders = normalizeHeadersForExport(table, filtered.headers);
    const outPath = join(outputDir, `filtered-keywords-${stamp}.xlsx`);
    writeXlsxFile(outPath, exportHeaders, filtered.matched);
    client.taskLog(`wrote ${outPath} matched=${filtered.matched.length}`);

    const kwLabel = keywords.length ? keywords.join('、') : '（未填）';
    const timeAdaptNote = endAdaptedFromBlank
      ? '（止留空，已适配为当前时刻）'
      : startAdaptedFromBlank
        ? '（起留空，已适配为不限起点）'
        : '';
    const timeLabel =
      publishStart != null || publishEnd != null
        ? `${publishStart != null ? formatUnix(publishStart) : '不限'} ~ ${publishEnd != null ? formatUnix(publishEnd) : '不限'}${timeAdaptNote}`
        : '（未设置）';
    const likeLabel =
      likeMin != null || likeMax != null
        ? `${likeMin ?? '不限'} ~ ${likeMax ?? '不限'}`
        : '（留空，不按点赞筛选）';

    const summary = [
      '## 筛选完成',
      '',
      `- 数据来源：${sourceLabel}`,
      `- 输入行数：${filtered.totalRows}`,
      `- 命中行数：**${filtered.matched.length}**`,
      filtered.skippedOutOfRange
        ? `- 因时间范围排除：${filtered.skippedOutOfRange}`
        : null,
      filtered.skippedNoTime
        ? `- 跳过（无法算出实际发布时间）：${filtered.skippedNoTime}`
        : null,
      filtered.skippedOutOfLike
        ? `- 因点赞数范围排除：${filtered.skippedOutOfLike}`
        : null,
      filtered.skippedNoLike
        ? `- 跳过（无法解析点赞数）：${filtered.skippedNoLike}`
        : null,
      `- 关键词（整行匹配）：${kwLabel}`,
      `- 筛选时间范围：${timeLabel}`,
      `- 点赞数范围：${likeLabel}${filtered.likeFilterApplied ? '（已应用，支持 71.4K / 2M / 万）' : ''}`,
      `- 字段识别：${filtered.detectNote}`,
      `- 导出文件：\`${outPath}\`（xlsx；表头按原文件适配，含「实际发布时间」）`,
      '',
      '### 实际发布时间算法',
      '',
      '自动适配字段，精度支持 **年 / 月 / 日 / 时 / 分 / 秒**：',
      '- 表中已有 **实际发布时间** 列时优先直接使用（如 `2026/10/9 9:59:37`）',
      '- **发布日期/时间**（绝对）：如 `2025/6/7`、`9-18`、`2024-1-12`',
      '- **采集时间 + 相对**：`2d ago` / `30秒前` / `10分钟前` / `3个月前` / `1年前`',
      '- 起填、止留空 → 自动适配为「起～当前时刻」；止填、起留空 → 自动适配为「不限起～止」',
      '',
      '### 点赞热度',
      '',
      '- 自动识别「点赞数」列；解析 `4998` / `71.4K` / `2M` / `1.2万`',
      '- 按你设置的最小~最大区间筛选热门内容',
      '',
      filtered.explainSamples.length
        ? ['### 推算示例', '', ...filtered.explainSamples.map((e) => `- ${e}`)].join('\n')
        : null,
      '',
      '### 命中预览',
      '',
      buildPreviewMarkdown(filtered.headers, filtered.matched, 10),
    ]
      .filter((x) => x != null)
      .join('\n');

    return {
      succ: true,
      msg: `matched ${filtered.matched.length} / ${filtered.totalRows}`,
      data: {
        matchCount: filtered.matched.length,
        resultFile: outPath,
        summary,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : `${e}`;
    client.taskLog(`filter failed: ${msg}`);
    return {
      succ: false,
      msg,
      data: {
        matchCount: 0,
        resultFile: '',
        summary: `## 筛选失败\n\n${msg}${sourceLabel ? `\n\n来源：${sourceLabel}` : ''}`,
      },
    };
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);
process.exit(await XportContentClient.run((client) => runContentTask(client, taskConfig)));
