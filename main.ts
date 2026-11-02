/**
 * 关键词采视频 → 筛选确认 → 循环：采评论 → 去重 → 筛选确认 → 关注+私信（直到取消）
 * 同类型子任务并行入队。
 */
import { join } from 'node:path';
import type { WorkflowRunConfig } from './config.types';
import {
  batchCheckpointButtons,
  loadWorkflowManifest,
  loadWorkflowRunConfig,
  type AutomationRunResult,
  type WorkflowContext,
  XportWorkflowClient,
} from 'xport-workflow-sdk';

type VideoRow = {
  videoUrl: string;
  caption: string;
  publishDate: string;
  likeCount: string;
};

type CommentRow = {
  profileUrl: string;
  userName: string;
  commentContent: string;
  commentDate: string;
};

type FilterRowsMod = {
  parseKeywords: (raw: string) => string[];
  parseTableText: (text: string) => { headers: string[]; rows: string[][] };
  filterRows: (
    table: { headers: string[]; rows: string[][] },
    opts: {
      keywords: string[];
      publishStartSec: number | null;
      publishEndSec: number | null;
      likeMin: number | null;
      likeMax: number | null;
    },
  ) => { headers: string[]; matched: string[][]; totalRows: number };
};

/** 含采集时间，便于筛选脚本用「发布日期+采集时间」推算实际发布时间（如 7-18、4d ago） */
const VIDEO_HEADERS = ['视频链接', '文案', '发布日期', '点赞数', '采集时间'] as const;
/** 含采集时间，便于筛选脚本用「评论日期+采集时间」推算实际发布时间 */
const COMMENT_HEADERS = ['用户主页链接', '用户名', '评论内容', '评论日期', '采集时间'] as const;

function cacheDir(): string {
  const dir = Bun.env.AUTOMATION_CACHE_DIR?.trim();
  if (!dir) throw new Error('AUTOMATION_CACHE_DIR is required');
  return dir;
}

function sdkPath(): string {
  const p = Bun.env.SDK_PATH?.trim();
  if (!p) throw new Error('SDK_PATH is required');
  return p;
}

function splitLines(raw: unknown): string[] {
  return `${raw ?? ''}`
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBrowserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
}

function cell(v: unknown): string {
  return `${v ?? ''}`.replace(/[\t\r\n]+/g, ' ').trim();
}

function asStr(v: unknown): string {
  return cell(v);
}

/** 与 filtering-keyword 一致：空 / ≤0 视为未设置 */
function optionalUnixNull(v: unknown): number | null {
  if (v == null || `${v}`.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function optionalLikeNull(v: unknown): number | null {
  if (v == null || `${v}`.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeUrl(url: string): string {
  const raw = url.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    let out = u.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out.toLowerCase();
  } catch {
    return raw.replace(/\/$/, '').toLowerCase();
  }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

function hasAnyFilter(
  keywords: string,
  start: unknown,
  end: unknown,
  likeMin: unknown = '',
  likeMax: unknown = '',
): boolean {
  const kw = `${keywords ?? ''}`.trim();
  return (
    kw.length > 0 ||
    optionalUnixNull(start) != null ||
    optionalUnixNull(end) != null ||
    optionalLikeNull(likeMin) != null ||
    optionalLikeNull(likeMax) != null
  );
}

async function ensureDir(dir: string): Promise<void> {
  await Bun.write(join(dir, '.keep'), '');
}

/** 查询接口可能把业务字段放在 payload / payloadJson / data / fields 内 */
function unwrapDataRow(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> = { ...row };
  const merge = (raw: unknown) => {
    if (raw == null) return;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      out = { ...out, ...(raw as Record<string, unknown>) };
      return;
    }
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (!t) return;
      try {
        const parsed = JSON.parse(t) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          out = { ...out, ...(parsed as Record<string, unknown>) };
        }
      } catch {
        /* ignore */
      }
    }
  };
  merge(row.payload);
  merge(row.payloadJson);
  merge(row.data);
  merge(row.fields);
  return out;
}

function videoFromRaw(raw: Record<string, unknown>): VideoRow | null {
  const p = unwrapDataRow(raw);
  const videoUrl = cell(p.videoUrl ?? p['视频链接'] ?? p.url ?? p.video_url);
  if (!videoUrl) return null;
  return {
    videoUrl,
    caption: cell(p.caption ?? p['文案'] ?? p.desc ?? p.description),
    publishDate: cell(p.publishDate ?? p['发布日期'] ?? p.publish_date ?? p.date),
    likeCount: cell(p.likeCount ?? p['点赞数'] ?? p.like_count ?? p.likes),
  };
}

function commentFromRaw(raw: Record<string, unknown>): CommentRow | null {
  const p = unwrapDataRow(raw);
  const profileUrl = cell(
    p.profileUrl ?? p['用户主页链接'] ?? p.host ?? p.profile_url ?? p.homepage,
  );
  if (!profileUrl) return null;
  return {
    profileUrl,
    userName: cell(p.userName ?? p['用户名'] ?? p.nickname ?? p.name),
    commentContent: cell(p.commentContent ?? p['评论内容'] ?? p.comment ?? p.content),
    commentDate: cell(p.commentDate ?? p['评论日期'] ?? p.date),
  };
}

async function loadFilterRowsMod(): Promise<FilterRowsMod> {
  const modPath = join(sdkPath(), 'filtering-keyword', 'filter_rows.ts');
  return (await import(modPath)) as FilterRowsMod;
}

async function readFilterResultTable(
  resultFile: string,
  filterMod: FilterRowsMod,
): Promise<{ headers: string[]; rows: string[][] } | null> {
  if (!resultFile || !(await Bun.file(resultFile).exists())) return null;
  try {
    const loadModPath = join(sdkPath(), 'filtering-keyword', 'load_source.ts');
    const loadMod = (await import(loadModPath)) as {
      readFileAsTableText: (path: string) => Promise<string>;
    };
    const text = await loadMod.readFileAsTableText(resultFile);
    const parsed = filterMod.parseTableText(text);
    if (!parsed.rows.length) return { headers: parsed.headers, rows: [] };
    return parsed;
  } catch {
    return null;
  }
}

function findCol(headers: string[], patterns: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i] ?? '';
    if (patterns.some((re) => re.test(h))) return i;
  }
  return -1;
}

function tableToVideos(headers: string[], rows: string[][]): VideoRow[] {
  const urlIdx = findCol(headers, [/视频\s*链接|影片\s*連結|video\s*url|^url$/i]);
  const capIdx = findCol(headers, [/文案|caption/i]);
  const dateIdx = findCol(headers, [/实际\s*发布|實際\s*發布|发布\s*日期|發佈\s*日期|publish/i]);
  const likeIdx = findCol(headers, [/点赞|按讚|likes?/i]);
  if (urlIdx < 0) return [];
  const out: VideoRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const videoUrl = cell(row[urlIdx]);
    if (!videoUrl) continue;
    const key = normalizeUrl(videoUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      videoUrl,
      caption: capIdx >= 0 ? cell(row[capIdx]) : '',
      publishDate: dateIdx >= 0 ? cell(row[dateIdx]) : '',
      likeCount: likeIdx >= 0 ? cell(row[likeIdx]) : '',
    });
  }
  return out;
}

function lookLikeProfileUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return /tiktok\.com\/@/i.test(t) || /^https?:\/\/.+\/@/i.test(t);
}

function tableToComments(
  headers: string[],
  rows: string[][],
  fallbackByUrl?: Map<string, CommentRow>,
): CommentRow[] {
  let urlIdx = findCol(headers, [/主页|主頁|profile\s*url|用户主页|^host$/i]);
  const nameIdx = findCol(headers, [/用户名|使用者名稱|display\s*name|user\s*name|昵称/i]);
  const contentIdx = findCol(headers, [/评论内容|評論內容|comment\s*content|^comment$/i]);
  const dateIdx = findCol(headers, [/评论日期|評論日期|comment\s*date|实际\s*发布/i]);
  if (urlIdx < 0 && rows[0]) {
    for (let c = 0; c < (rows[0]?.length ?? 0); c++) {
      if (lookLikeProfileUrl(cell(rows[0]![c]))) {
        urlIdx = c;
        break;
      }
    }
  }
  const out: CommentRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let profileUrl = urlIdx >= 0 ? cell(row[urlIdx]) : '';
    if (!profileUrl) {
      for (const c of row) {
        if (lookLikeProfileUrl(cell(c))) {
          profileUrl = cell(c);
          break;
        }
      }
    }
    if (!profileUrl) continue;
    const key = normalizeUrl(profileUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const fb = fallbackByUrl?.get(key);
    out.push({
      profileUrl: fb?.profileUrl || profileUrl,
      userName: (nameIdx >= 0 ? cell(row[nameIdx]) : '') || fb?.userName || '',
      commentContent: (contentIdx >= 0 ? cell(row[contentIdx]) : '') || fb?.commentContent || '',
      commentDate: (dateIdx >= 0 ? cell(row[dateIdx]) : '') || fb?.commentDate || '',
    });
  }
  return out;
}

async function fetchCmdRows<T>(
  ctx: WorkflowContext,
  cmd: string,
  taskIds: number[],
  parse: (raw: Record<string, unknown>) => T | null,
  keyOf: (item: T) => string,
): Promise<{ items: T[]; note: string }> {
  const byKey = new Map<string, T>();
  const notes: string[] = [];

  const tryQuery = async (label: string, taskId?: number) => {
    const [ok, msg, all] = await ctx.fetchAllAutomationData(cmd, {
      ...(taskId != null && taskId > 0 ? { taskId } : {}),
    });
    if (!ok || !all) {
      notes.push(`${label}: ${msg || 'query failed'}`);
      return;
    }
    let parsed = 0;
    for (const raw of all.rows ?? []) {
      const item = parse(raw as Record<string, unknown>);
      if (!item) continue;
      const key = keyOf(item);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, item);
      parsed += 1;
    }
    const sample = all.rows?.[0] as Record<string, unknown> | undefined;
    notes.push(
      `${label}: raw=${all.rows?.length ?? 0} parsed+=${parsed} keys=${sample ? Object.keys(sample).join(',') : '(empty)'}`,
    );
  };

  for (const taskId of taskIds) {
    if (taskId > 0) await tryQuery(`taskId=${taskId}`, taskId);
  }
  // 始终合并本任务组内该 cmd 的行（并行时部分失败也不丢已成功入库的数据）
  await tryQuery('gid-only');

  return { items: [...byKey.values()], note: notes.join(' | ') };
}

type StepOutcome = {
  succ: boolean;
  msg: string;
  data: Record<string, unknown>;
  taskId: number;
  label: string;
};

async function runParallelSafe(
  items: string[],
  browserIds: number[],
  runOne: (item: string, deviceId: number, index: number) => Promise<{
    succ: boolean;
    msg: string;
    data: Record<string, unknown>;
    taskId: number;
  }>,
): Promise<StepOutcome[]> {
  return Promise.all(
    items.map(async (item, i) => {
      const deviceId = browserIds[i % browserIds.length]!;
      try {
        const step = await runOne(item, deviceId, i);
        return {
          succ: step.succ,
          msg: step.msg || '',
          data: step.data ?? {},
          taskId: step.taskId || 0,
          label: item,
        };
      } catch (e) {
        return {
          succ: false,
          msg: e instanceof Error ? e.message : `${e}`,
          data: {},
          taskId: 0,
          label: item,
        };
      }
    }),
  );
}

async function collectVideos(
  ctx: WorkflowContext,
  keywords: string[],
  collectCount: number,
  browserIds: number[],
): Promise<{ succ: boolean; msg: string; rows: VideoRow[] }> {
  ctx.workflowLog(`collect videos parallel x${keywords.length}`);
  const steps = await runParallelSafe(keywords, browserIds, (keyword, deviceId) =>
    ctx.runAutomation({
      cmd: 'tk-keywords-video',
      deviceId,
      target: 'browser',
      config: { keyword, collectCount },
    }),
  );
  const okSteps = steps.filter((s) => s.succ);
  const failSteps = steps.filter((s) => !s.succ);
  for (const f of failSteps.slice(0, 8)) {
    ctx.workflowLog(`video collect fail keyword=${f.label}: ${f.msg}`);
  }
  if (failSteps.length > 8) {
    ctx.workflowLog(`video collect fail …另有 ${failSteps.length - 8} 个`);
  }
  ctx.workflowLog(`video collect done ok=${okSteps.length}/${steps.length}`);

  if (okSteps.length === 0) {
    return {
      succ: false,
      msg: failSteps[0]?.msg || '全部关键词视频采集均失败',
      rows: [],
    };
  }

  const reported = okSteps.reduce((n, s) => n + Number(s.data?.collectedCount ?? 0), 0);
  const fetched = await fetchCmdRows(
    ctx,
    'tk-keywords-video',
    okSteps.map((s) => s.taskId),
    videoFromRaw,
    (r) => normalizeUrl(r.videoUrl),
  );
  ctx.workflowLog(`collect videos reported=${reported} ${fetched.note}`);
  if (fetched.items.length === 0) {
    return {
      succ: false,
      msg:
        reported > 0
          ? `采集任务已有成功（回报 ${reported} 条），但编排未能读到可筛选的视频行`
          : `视频采集部分成功 ${okSteps.length}/${steps.length}，但未读到数据行`,
      rows: [],
    };
  }
  return {
    succ: true,
    msg: `ok videos=${fetched.items.length} tasks=${okSteps.length}/${steps.length}`,
    rows: fetched.items,
  };
}

async function collectCommentsForVideos(
  ctx: WorkflowContext,
  videoUrls: string[],
  maxComments: number,
  browserIds: number[],
): Promise<{ succ: boolean; msg: string; rows: CommentRow[] }> {
  ctx.workflowLog(`collect comments parallel x${videoUrls.length}`);
  const steps = await runParallelSafe(videoUrls, browserIds, (videoUrl, deviceId) =>
    ctx.runAutomation({
      cmd: 'tk-clollect-comment',
      deviceId,
      target: 'browser',
      config: { videoUrl, maxComments },
    }),
  );
  const okSteps = steps.filter((s) => s.succ);
  const failSteps = steps.filter((s) => !s.succ);
  for (const f of failSteps.slice(0, 10)) {
    ctx.workflowLog(`comment collect fail: ${f.msg}`);
  }
  if (failSteps.length > 10) {
    ctx.workflowLog(`comment collect fail …另有 ${failSteps.length - 10} 个`);
  }
  ctx.workflowLog(`comment collect done ok=${okSteps.length}/${steps.length}`);

  // 关键失败不整批中止：用已成功的评论继续筛选确认
  if (okSteps.length === 0) {
    return {
      succ: false,
      msg:
        failSteps[0]?.msg ||
        `全部 ${steps.length} 个评论采集均失败（验证码/网络等），无法进入筛选`,
      rows: [],
    };
  }

  const reported = okSteps.reduce((n, s) => n + Number(s.data?.collectedCount ?? 0), 0);
  const fetched = await fetchCmdRows(
    ctx,
    'tk-clollect-comment',
    okSteps.map((s) => s.taskId),
    commentFromRaw,
    (r) => normalizeUrl(r.profileUrl),
  );
  ctx.workflowLog(
    `collect comments reported=${reported} parsed=${fetched.items.length} failTasks=${failSteps.length} ${fetched.note}`,
  );
  // 子脚本已将验证码/网络等标为 succ:true（跳过）；可能全部软跳过导致 0 行——仍继续编排
  if (fetched.items.length === 0) {
    ctx.workflowLog(
      `comment collect soft-empty: okTasks=${okSteps.length}/${steps.length} reported=${reported}`,
    );
    return {
      succ: true,
      msg: `ok comments=0 tasks=${okSteps.length}/${steps.length}`,
      rows: [],
    };
  }
  return {
    succ: true,
    msg: `ok comments=${fetched.items.length} tasks=${okSteps.length}/${steps.length}`,
    rows: fetched.items,
  };
}

async function runFilterChild(
  ctx: WorkflowContext,
  opts: {
    sourceFile: string;
    keywords: string;
    publishStart: number | null;
    publishEnd: number | null;
    likeMin: number | null;
    likeMax: number | null;
    outputDir: string;
  },
): Promise<{ succ: boolean; msg: string; resultFile: string; matchCount: number }> {
  const step = await ctx.runAutomation({
    cmd: 'filtering-keyword',
    deviceId: 0,
    target: 'client',
    config: {
      sourceFile: opts.sourceFile,
      keywords: opts.keywords ?? '',
      publishStart: opts.publishStart ?? 0,
      publishEnd: opts.publishEnd ?? 0,
      likeMin: opts.likeMin ?? 0,
      likeMax: opts.likeMax ?? 0,
      outputDir: opts.outputDir,
    },
  });
  return {
    succ: step.succ,
    msg: step.msg || '',
    resultFile: asStr(step.data?.resultFile),
    matchCount: Number(step.data?.matchCount ?? 0) || 0,
  };
}

/** 子任务筛选 + 本地同源复筛，得到确认用命中表（禁止用未筛选全集兜底） */
async function resolveMatchedTable(
  ctx: WorkflowContext,
  opts: {
    tsvText: string;
    sourceJsonPath: string;
    keywords: string;
    publishStart: number | null;
    publishEnd: number | null;
    likeMin: number | null;
    likeMax: number | null;
    outputDir: string;
    defaultHeaders: readonly string[];
  },
): Promise<{ succ: boolean; msg: string; headers: string[]; matched: string[][]; childMatch: number }> {
  let publishStart = opts.publishStart;
  let publishEnd = opts.publishEnd;
  // 与 filtering-keyword 一致：只填起、止空 → 止适配当前时刻
  if (publishStart != null && publishEnd == null) {
    publishEnd = Math.floor(Date.now() / 1000);
  }

  const child = await runFilterChild(ctx, {
    sourceFile: opts.sourceJsonPath,
    keywords: opts.keywords,
    publishStart,
    publishEnd,
    likeMin: opts.likeMin,
    likeMax: opts.likeMax,
    outputDir: opts.outputDir,
  });
  if (!child.succ) {
    return {
      succ: false,
      msg: child.msg || '筛选任务失败',
      headers: [...opts.defaultHeaders],
      matched: [],
      childMatch: 0,
    };
  }
  ctx.workflowLog(`filtering-keyword ok matchCount=${child.matchCount} file=${child.resultFile || '(none)'}`);

  const filterMod = await loadFilterRowsMod();
  let headers: string[] = [...opts.defaultHeaders];
  let matched: string[][] = [];

  const fromFile = await readFilterResultTable(child.resultFile, filterMod);
  if (fromFile && fromFile.rows.length > 0) {
    headers = fromFile.headers;
    matched = fromFile.rows;
    ctx.workflowLog(`confirm table from filter file rows=${matched.length}`);
  }

  if (matched.length === 0) {
    const kwList = filterMod.parseKeywords(opts.keywords);
    const table = filterMod.parseTableText(opts.tsvText);
    const filtered = filterMod.filterRows(table, {
      keywords: kwList,
      publishStartSec: publishStart,
      publishEndSec: publishEnd,
      likeMin: opts.likeMin,
      likeMax: opts.likeMax,
    });
    headers = filtered.headers.length ? filtered.headers : [...opts.defaultHeaders];
    matched = filtered.matched;
    ctx.workflowLog(
      `confirm table from local re-filter rows=${matched.length} childReported=${child.matchCount}`,
    );
  }

  return {
    succ: true,
    msg: 'ok',
    headers,
    matched,
    childMatch: child.matchCount,
  };
}

async function runWorkflow(ctx: WorkflowContext, cfg: WorkflowRunConfig): Promise<AutomationRunResult> {
  const keywords = splitLines(cfg.keywords);
  const browserIds = parseBrowserIds(cfg.browsers);
  const collectCount = Math.max(1, Math.floor(Number(cfg.collectCount) || 20));
  const maxComments = Math.max(1, Math.floor(Number(cfg.maxComments) || 100));
  const intervalMinutes = Math.max(1, Math.floor(Number(cfg.intervalMinutes) || 60));
  const messages = asStr(cfg.messages);
  const attachment = cfg.attachment ?? null;

  const videoKw = asStr(cfg.videoFilterKeywords);
  const commentKw = asStr(cfg.commentFilterKeywords);
  let videoPublishStart = optionalUnixNull(cfg.videoPublishStart);
  let videoPublishEnd = optionalUnixNull(cfg.videoPublishEnd);
  let videoLikeMin = optionalLikeNull(cfg.videoLikeMin);
  let videoLikeMax = optionalLikeNull(cfg.videoLikeMax);
  let commentPublishStart = optionalUnixNull(cfg.commentPublishStart);
  let commentPublishEnd = optionalUnixNull(cfg.commentPublishEnd);

  const resultBase = () => ({
    roundCount: 0,
    selectedVideoCount: 0,
    newUserCount: 0,
    followOkCount: 0,
    dmOkCount: 0,
    summary: '',
  });

  if (keywords.length === 0) {
    return { succ: false, msg: '请填写搜索关键词', data: resultBase() };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: '请选择执行浏览器', data: resultBase() };
  }
  if (!hasAnyFilter(videoKw, cfg.videoPublishStart, cfg.videoPublishEnd, cfg.videoLikeMin, cfg.videoLikeMax)) {
    return { succ: false, msg: '请至少填写一项视频筛选条件（关键词/时间/点赞）', data: resultBase() };
  }
  if (!hasAnyFilter(commentKw, cfg.commentPublishStart, cfg.commentPublishEnd)) {
    return { succ: false, msg: '请至少填写一项评论筛选条件（关键词/时间）', data: resultBase() };
  }
  if (!messages) {
    return { succ: false, msg: '请填写私信文案', data: resultBase() };
  }

  const outDir = join(cacheDir(), `wf-${ctx.gid}`);
  await ensureDir(outDir);

  let roundCount = 0;
  let selectedVideoCount = 0;
  let newUserCount = 0;
  let followOkCount = 0;
  let dmOkCount = 0;

  const finish = (succ: boolean, msg: string): AutomationRunResult => ({
    succ,
    msg,
    data: {
      roundCount,
      selectedVideoCount,
      newUserCount,
      followOkCount,
      dmOkCount,
      summary: msg,
    },
  });

  // —— 1) 采视频（仅一次，并行）——
  const collected = await collectVideos(ctx, keywords, collectCount, browserIds);
  if (!collected.succ) return finish(false, collected.msg);

  const emptyLikes = collected.rows.filter((r) => !r.likeCount).length;
  // 与评论一致：写入采集时间，否则「7-18」「4d ago」会被当成绝对年份而整批被时间筛掉
  const videoCollectTime = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const videoTsvText = [
    VIDEO_HEADERS.join('\t'),
    ...collected.rows.map((r) =>
      [r.videoUrl, r.caption, r.publishDate, r.likeCount, videoCollectTime].join('\t'),
    ),
  ].join('\n');
  const videoJsonPath = join(outDir, 'videos-raw.json');
  await Bun.write(
    videoJsonPath,
    `${JSON.stringify(
      collected.rows.map((r) => ({
        视频链接: r.videoUrl,
        文案: r.caption,
        发布日期: r.publishDate,
        点赞数: r.likeCount,
        采集时间: videoCollectTime,
      })),
      null,
      2,
    )}\n`,
  );
  await Bun.write(join(outDir, 'videos-raw.tsv'), `${videoTsvText}\n`);
  ctx.workflowLog(
    `wrote video source rows=${collected.rows.length} emptyLikes=${emptyLikes} collectTime=${videoCollectTime}`,
  );

  // 采集脚本当前常拿不到点赞：若仍按点赞筛会整批落空。点赞全空时自动忽略点赞条件，改靠关键词/时间。
  let skippedLikeFilterForEmpty = false;
  if (
    collected.rows.length > 0 &&
    emptyLikes === collected.rows.length &&
    (videoLikeMin != null || videoLikeMax != null)
  ) {
    skippedLikeFilterForEmpty = true;
    ctx.workflowLog(
      `all likes empty (${emptyLikes}); ignore likeMin=${videoLikeMin} likeMax=${videoLikeMax}`,
    );
    videoLikeMin = null;
    videoLikeMax = null;
    if (!hasAnyFilter(videoKw, cfg.videoPublishStart, cfg.videoPublishEnd)) {
      return finish(
        false,
        `采集 ${collected.rows.length} 条视频点赞全部为空，无法按点赞筛选，且未填视频关键词/时间。请先只填关键词或时间，或清空点赞条件后重试`,
      );
    }
  }

  const videoMatched = await resolveMatchedTable(ctx, {
    tsvText: videoTsvText,
    sourceJsonPath: videoJsonPath,
    keywords: videoKw,
    publishStart: videoPublishStart,
    publishEnd: videoPublishEnd,
    likeMin: videoLikeMin,
    likeMax: videoLikeMax,
    outputDir: outDir,
    defaultHeaders: VIDEO_HEADERS,
  });
  if (!videoMatched.succ) return finish(false, videoMatched.msg);

  const filteredVideoRows = tableToVideos(videoMatched.headers, videoMatched.matched);
  if (filteredVideoRows.length === 0) {
    return finish(
      false,
      `视频筛选命中 0 条（采集 ${collected.rows.length} 条）。请放宽视频关键词或时间后再试`,
    );
  }

  // —— 2) 人工确认视频 ——
  const likeHint = skippedLikeFilterForEmpty
    ? ` 注意：采集点赞全部为空，已自动跳过点赞条件，仅按关键词/时间筛出 ${filteredVideoRows.length} 条。`
    : emptyLikes > 0
      ? ` 注意：采集中有 ${emptyLikes}/${collected.rows.length} 条点赞为空。`
      : '';
  ctx.workflowLog(`humanConfirm videos options=${filteredVideoRows.length}`);
  const videoPick = await ctx.humanConfirm({
    scenario: 'media_pick_many',
    title: '确认要采集评论的视频',
    message: `筛选命中 ${filteredVideoRows.length} 条（子任务报 ${videoMatched.childMatch}）。请至少选 1 条；若不在详情页请看底部确认浮层。${likeHint}`,
    options: filteredVideoRows.map((r, i) => ({
      id: `v-${i}`,
      label: clip(r.caption || r.videoUrl || `视频 ${i + 1}`, 80),
      description: clip(
        `${r.likeCount ? `赞 ${r.likeCount} · ` : ''}${r.publishDate ? `${r.publishDate} · ` : ''}${r.videoUrl}`,
        160,
      ),
      mediaType: 'text' as const,
    })),
    buttons: {
      confirm: '用所选视频采评论',
      cancel: '结束并保留已处理结果',
    },
    selection: { mode: 'multiple', min: 1, max: filteredVideoRows.length },
  });
  ctx.workflowLog(`humanConfirm videos type=${videoPick.type}`);
  if (videoPick.type !== 'approved') {
    return finish(true, videoPick.type === 'cancelled' ? '已取消：未确认视频，保留当前进度' : videoPick.msg);
  }
  const selectedVideos = videoPick.selectedOptionIds
    .map((id) => {
      const m = /^v-(\d+)$/.exec(id);
      if (!m) return '';
      return filteredVideoRows[Number(m[1])]?.videoUrl ?? '';
    })
    .filter(Boolean);
  selectedVideoCount = selectedVideos.length;
  if (selectedVideos.length === 0) {
    return finish(true, '未选择视频，已结束');
  }

  const seenProfiles = new Set<string>();

  // —— 3) 循环：评论 → 去重 → 筛选确认 → 关注私信 ——
  for (let round = 1; ; round++) {
    roundCount = round;
    ctx.workflowLog(`=== round ${round} ===`);

    const commentCollected = await collectCommentsForVideos(ctx, selectedVideos, maxComments, browserIds);
    if (!commentCollected.succ) return finish(false, commentCollected.msg);

    const fresh: CommentRow[] = [];
    const freshKeys = new Set<string>();
    const freshByUrl = new Map<string, CommentRow>();
    for (const row of commentCollected.rows) {
      const key = normalizeUrl(row.profileUrl);
      if (!key || seenProfiles.has(key) || freshKeys.has(key)) continue;
      freshKeys.add(key);
      fresh.push(row);
      freshByUrl.set(key, row);
    }
    for (const row of commentCollected.rows) {
      const key = normalizeUrl(row.profileUrl);
      if (key) seenProfiles.add(key);
    }
    ctx.workflowLog(
      `round ${round}: collected=${commentCollected.rows.length} fresh=${fresh.length} seen=${seenProfiles.size}`,
    );

    // 无新主页：明确告知，不要冒充「筛选后确认」
    if (fresh.length === 0) {
      const noFresh = await ctx.humanConfirm({
        scenario: 'batch_checkpoint',
        title: `第 ${round} 轮：无新用户可筛选`,
        message: `本轮采集 ${commentCollected.rows.length} 条评论，去重后 0 个新主页（均已在历史轮次出现过），因此跳过筛选与确认。累计确认用户 ${newUserCount}。`,
        buttons: batchCheckpointButtons({
          continueNext: '等待后继续下一轮',
          stop: '结束并保留已处理结果',
        }),
      });
      if (noFresh.actionId === 'stop' || noFresh.type === 'cancelled' || noFresh.type === 'failed') {
        return finish(
          true,
          noFresh.type === 'failed'
            ? noFresh.msg
            : `已结束：完成 ${roundCount} 轮，确认用户 ${newUserCount}，关注 ${followOkCount}，私信 ${dmOkCount}`,
        );
      }
      ctx.workflowLog(`sleep ${intervalMinutes} minutes before next round`);
      await Bun.sleep(intervalMinutes * 60 * 1000);
      continue;
    }

    // —— 必须先筛选，再弹「用户确认」——
    const collectTime = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const commentTsvText = [
      COMMENT_HEADERS.join('\t'),
      ...fresh.map((r) =>
        [r.profileUrl, r.userName, r.commentContent, r.commentDate, collectTime].join('\t'),
      ),
    ].join('\n');
    const commentJsonPath = join(outDir, `comments-round-${round}.json`);
    await Bun.write(
      commentJsonPath,
      `${JSON.stringify(
        fresh.map((r) => ({
          用户主页链接: r.profileUrl,
          用户名: r.userName,
          评论内容: r.commentContent,
          评论日期: r.commentDate,
          采集时间: collectTime,
        })),
        null,
        2,
      )}\n`,
    );
    await Bun.write(join(outDir, `comments-round-${round}.tsv`), `${commentTsvText}\n`);
    ctx.workflowLog(`round ${round}: start comment filter on fresh=${fresh.length}`);

    const commentMatched = await resolveMatchedTable(ctx, {
      tsvText: commentTsvText,
      sourceJsonPath: commentJsonPath,
      keywords: commentKw,
      publishStart: commentPublishStart,
      publishEnd: commentPublishEnd,
      likeMin: null,
      likeMax: null,
      outputDir: outDir,
      defaultHeaders: COMMENT_HEADERS,
    });
    if (!commentMatched.succ) return finish(false, commentMatched.msg);

    const candidates = tableToComments(commentMatched.headers, commentMatched.matched, freshByUrl);
    ctx.workflowLog(
      `round ${round}: filter done childMatch=${commentMatched.childMatch} candidates=${candidates.length} matchedRows=${commentMatched.matched.length}`,
    );

    if (candidates.length === 0) {
      const zero = await ctx.humanConfirm({
        scenario: 'batch_checkpoint',
        title: `第 ${round} 轮：评论筛选命中 0 人`,
        message: `去重新主页 ${fresh.length} 人，按你的评论筛选条件命中 0 人，未进入关注私信。请放宽评论关键词/时间后再试。累计确认用户 ${newUserCount}。`,
        buttons: batchCheckpointButtons({
          continueNext: '等待后继续下一轮',
          stop: '结束并保留已处理结果',
        }),
      });
      if (zero.actionId === 'stop' || zero.type === 'cancelled' || zero.type === 'failed') {
        return finish(
          true,
          zero.type === 'failed'
            ? zero.msg
            : `已结束：完成 ${roundCount} 轮，确认用户 ${newUserCount}，关注 ${followOkCount}，私信 ${dmOkCount}`,
        );
      }
      ctx.workflowLog(`sleep ${intervalMinutes} minutes before next round`);
      await Bun.sleep(intervalMinutes * 60 * 1000);
      continue;
    }

    ctx.workflowLog(`humanConfirm users options=${candidates.length}`);
    const userPick = await ctx.humanConfirm({
      scenario: 'media_pick_many',
      title: `第 ${round} 轮：确认筛选后的用户`,
      message: `已完成评论筛选：去重 ${fresh.length} → 命中 ${candidates.length} 人（子任务报 ${commentMatched.childMatch}）。请勾选要关注并私信的用户；若不在详情页请看底部确认浮层。`,
      options: candidates.map((r, i) => ({
        id: `u-${i}`,
        label: clip(r.userName || `用户 ${i + 1}`, 80),
        description: clip(
          `${r.commentDate ? `${r.commentDate} · ` : ''}${r.commentContent || r.profileUrl}`,
          160,
        ),
        mediaType: 'text' as const,
      })),
      buttons: {
        confirm: '关注并私信所选用户',
        cancel: '结束并保留已处理结果',
      },
      selection: { mode: 'multiple', min: 1, max: candidates.length },
    });
    ctx.workflowLog(`humanConfirm users type=${userPick.type}`);
    if (userPick.type !== 'approved') {
      return finish(
        true,
        userPick.type === 'cancelled'
          ? `已取消：保留已处理结果（完成 ${roundCount} 轮，新用户 ${newUserCount}）`
          : userPick.msg,
      );
    }

    const selectedUsers = userPick.selectedOptionIds
      .map((id) => {
        const m = /^u-(\d+)$/.exec(id);
        if (!m) return '';
        return candidates[Number(m[1])]?.profileUrl ?? '';
      })
      .filter(Boolean);
    newUserCount += selectedUsers.length;

    ctx.workflowLog(`follow parallel x${selectedUsers.length}`);
    const followSteps = await Promise.all(
      selectedUsers.map((host, i) =>
        ctx.runAutomation({
          cmd: 'tk-auto-follow',
          deviceId: browserIds[i % browserIds.length]!,
          target: 'browser',
          config: { host },
        }),
      ),
    );
    for (let i = 0; i < followSteps.length; i++) {
      const follow = followSteps[i]!;
      if (follow.succ) followOkCount += 1;
      else ctx.workflowLog(`follow failed host=${selectedUsers[i]}: ${follow.msg}`);
    }

    ctx.workflowLog(`dm parallel x${selectedUsers.length}`);
    const dmSteps = await Promise.all(
      selectedUsers.map((host, i) =>
        ctx.runAutomation({
          cmd: 'tk-sendbulkdirectmessages-browser',
          deviceId: browserIds[i % browserIds.length]!,
          target: 'browser',
          config: { host, messages, attachment },
        }),
      ),
    );
    for (let i = 0; i < dmSteps.length; i++) {
      const dm = dmSteps[i]!;
      if (dm.succ) dmOkCount += 1;
      else ctx.workflowLog(`dm failed host=${selectedUsers[i]}: ${dm.msg}`);
    }

    const next = await ctx.humanConfirm({
      scenario: 'batch_checkpoint',
      title: `第 ${round} 轮已完成`,
      message: `本轮已筛选并处理完毕。累计确认用户 ${newUserCount}，关注成功 ${followOkCount}，私信成功 ${dmOkCount}。继续将等待 ${intervalMinutes} 分钟后再次采集评论。`,
      buttons: batchCheckpointButtons({
        continueNext: '等待后继续下一轮',
        stop: '结束并保留已处理结果',
      }),
    });
    if (next.actionId === 'stop' || next.type === 'cancelled' || next.type === 'failed') {
      return finish(
        true,
        next.type === 'failed'
          ? next.msg
          : `已结束：完成 ${roundCount} 轮，确认用户 ${newUserCount}，关注 ${followOkCount}，私信 ${dmOkCount}`,
      );
    }

    ctx.workflowLog(`sleep ${intervalMinutes} minutes before next round`);
    await Bun.sleep(intervalMinutes * 60 * 1000);
  }
}

const manifest = await loadWorkflowManifest();
const runConfig = await loadWorkflowRunConfig<WorkflowRunConfig>(manifest);

process.exit(
  await XportWorkflowClient.run((ctx) => runWorkflow(ctx, runConfig)),
);
