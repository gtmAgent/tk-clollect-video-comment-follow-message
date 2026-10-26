/**
 * TikTok 采集视频评论：打开视频 → 打开评论区 → 下滑采集评论入库。
 *
 * 环境变量：`DESKTOP_PORT`、`SDK_PATH`、`DEVICE_ID`、`LISTEN_PORT`、`TASK_ID`（或试跑 `RUN_CONFIG_KEY`）、
 * `AUTOMATION_CMD`、`SOCIAL_NAME`、`SOCIAL_HOME`、`CDP_URL`。
 */
import type { IntermediateDataRow, TaskRunConfig } from './config.types';
import {
  type AutomationFailureData,
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  prepareIntermediateStorage,
  XportBrowserClient,
} from 'xport-browser-sdk';

/**
 * 业务无法完成时仍标成功（工作流「跳过此任务」），msg / 结构化 data 与原失败路径一致，仅 succ=true。
 * 保留 captureIncident 现场；桌面按 succ 打成功标签。
 */
function skipTaskAsSuccess(msg: string, data: AutomationFailureData): AutomationRunResult {
  const fail = automationFailWithContext(msg, data);
  return { ...fail, succ: true };
}

function pathCommentIcon() {
  return nodePath().css('[data-e2e="comment-icon"]').one(0);
}
function pathCommentUsername() {
  return nodePath()
    .css('[class*="DivCommentListContainer"]')
    .then()
    .css('[data-e2e="comment-username-1"]');
}
function pathCommentItemLastVisible() {
  return nodePath()
    .css('[class*="DivCommentListContainer"]')
    .then()
    .css('[class*="DivCommentItemWrapper"]')
    .inViewport()
    .last();
}
/**
 * 评论区真正可滚容器（现场：overflowY=scroll；DivCommentListContainer 自身不可滚）。
 * 旧 DivScrollingContentContainer 几乎滚不动，会导致 stagnant 早停、只采到十几条。
 */
function pathCommentScrollMain() {
  return nodePath().css('[class*="DivCommentMain"]').one(0);
}
function pathCommentList() {
  return nodePath().css('[class*="DivCommentListContainer"]').one(0);
}
/** 右侧栏「Comments」页签（button[data-testid=tux-web-tab-bar]；文案须当场证据）。 */
function pathCommentsTab() {
  return nodePath()
    .css('[class*="RightPanelHeader"] button[data-testid="tux-web-tab-bar"]')
    // 英：Comments（用户截图）；日：コメント（inc_42202 HTML）
    .containAnyText('Comments', 'コメント')
    .one(0);
}
/** 无文案匹配时：右侧栏第一个页签即为 Comments（结构定位，兼容未观察语种）。 */
function pathCommentsTabFirst() {
  return nodePath()
    .css('[class*="RightPanelHeader"] button[data-testid="tux-web-tab-bar"]')
    .one(0);
}
function pathRelatedPanel() {
  return nodePath().css('[class*="DivRelatedTabContainer"]').one(0);
}

type ScrapedComment = {
  userName: string;
  profileUrl: string;
  commentContent: string;
  commentDate: string;
};

/** 单次导航超时；过长会导致并行任务长时间 running、编排 waitForTask 阻塞。 */
const NAV_TIMEOUT_MS = 40_000;
/**
 * 打开视频+恢复总墙钟预算。
 * chrome-error 最多刷 10 次（约 3s/次）+ 主动 reload，约 40–60s；另留评论入口等待余量。
 */
const OPEN_BUDGET_MS = 100_000;
const NAV_WAIT = 'domContentLoaded' as const;
/** 慢网：评论入口（icon / Comments 页签）可能晚挂载；出来立刻点，未出最多等此时长。 */
const COMMENT_ENTRY_WAIT_MS = 10_000;
const COMMENT_ENTRY_POLL_MS = 500;
/**
 * chrome-error / ERR_CONNECTION_CLOSED：约每 3s 自动刷新，客户规定最多刷 10 次；
 * 仍进不去再判网络问题，避免无限等。
 */
const CHROME_ERROR_REFRESH_WAIT_MS = 3_200;
const CHROME_ERROR_MAX_REFRESHES = 10;
/** 非 chrome-error 的恢复轮次（Oops 页 / 评论入口晚挂载）。 */
const OPEN_RECOVERY_ROUNDS = 4;

function parseMaxComments(raw: unknown, fallback = 100): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 5000);
}

function absolutizeProfileUrl(href: string): string {
  const h = href.trim();
  if (!h) return '';
  if (h.startsWith('http://') || h.startsWith('https://')) return h.split('?')[0]!;
  if (h.startsWith('/')) return `https://www.tiktok.com${h.split('?')[0]}`;
  return h;
}

/** 评论去重：只按主页链接；同一用户只保留首条（正文不去重）。 */
function commentDedupeKey(profileUrl: string): string {
  return profileUrl.trim().toLowerCase();
}

function budgetLeft(startedAt: number, budgetMs = OPEN_BUDGET_MS): number {
  return Math.max(0, budgetMs - (Date.now() - startedAt));
}

function looksLikeNavHardFail(msg: string | null | undefined): boolean {
  const m = (msg || '').toLowerCase();
  return (
    m.includes('err_connection') ||
    m.includes('err_timed_out') ||
    m.includes('err_tunnel') ||
    m.includes('err_proxy') ||
    m.includes('err_name_not_resolved') ||
    m.includes('net::') ||
    m.includes('chrome-error') ||
    m.includes('access denied')
  );
}

type CommentEntryKind = 'list' | 'tab' | 'icon' | null;

/** 评论入口是否已挂载（列表 / Comments 页签 / comment-icon）。 */
async function probeCommentEntry(client: XportBrowserClient): Promise<CommentEntryKind> {
  const [listOk, , listCount] = await client.getNodeCount(0, pathCommentUsername());
  if (listOk && (listCount ?? 0) >= 1) return 'list';
  const [tabOk, , tabCount] = await client.getNodeCount(0, pathCommentsTabFirst());
  if (tabOk && (tabCount ?? 0) >= 1) return 'tab';
  const [iconOk, , iconCount] = await client.getNodeCount(0, pathCommentIcon());
  if (iconOk && (iconCount ?? 0) >= 1) return 'icon';
  return null;
}

async function pageLooksReady(client: XportBrowserClient): Promise<boolean> {
  return (await probeCommentEntry(client)) != null;
}

/** 轮询评论入口：一出现就返回；超时返回最后一次探测结果（客户要求约 10s）。 */
async function waitForCommentEntry(
  client: XportBrowserClient,
  waitMs = COMMENT_ENTRY_WAIT_MS,
): Promise<CommentEntryKind> {
  const deadline = Date.now() + waitMs;
  client.taskLog(`wait comment entry up to ${waitMs}ms`);
  while (true) {
    const kind = await probeCommentEntry(client);
    if (kind) {
      client.taskLog(`comment entry appeared kind=${kind}`);
      return kind;
    }
    if (Date.now() >= deadline) break;
    await Bun.sleep(COMMENT_ENTRY_POLL_MS);
  }
  return probeCommentEntry(client);
}

async function isChromeErrorPage(client: XportBrowserClient): Promise<boolean> {
  const [, , url] = await client.getPageUrl();
  const u = (url || '').trim().toLowerCase();
  return u.startsWith('chrome-error://') || u.includes('chromewebdata');
}

async function isErrorLandingPage(client: XportBrowserClient): Promise<boolean> {
  if (await pageLooksReady(client)) return false;
  if (await isChromeErrorPage(client)) return true;
  const [, , title] = await client.getPageTitle();
  const t = (title || '').trim().toLowerCase();
  if (!t) return false;
  // 现场见过：Oops! / Site Maintenance；勿用整页 Oops 文案（易误伤通知栏）
  return t.includes('oops') || t.includes('maintenance') || t.includes('something went wrong');
}

async function hardRefreshRecovery(
  client: XportBrowserClient,
  videoUrl: string,
  startedAt: number,
): Promise<void> {
  // 现场：错误页 Ctrl+F5 可恢复；按键 API 无组合键，用 reload + 再导航逼近硬刷新。
  if (budgetLeft(startedAt) < 8_000) return;
  client.taskLog('error landing page → reload + re-open video');
  const reloadTimeout = Math.min(NAV_TIMEOUT_MS, budgetLeft(startedAt));
  await client.pageReload(0, { timeoutMs: reloadTimeout, wait: NAV_WAIT });
  await Bun.sleep(1000);
  if (await pageLooksReady(client)) return;
  if (!(await isErrorLandingPage(client))) return;
  if (budgetLeft(startedAt) < 8_000) return;
  await client.pageGoTo(0, {
    url: videoUrl,
    timeoutMs: Math.min(NAV_TIMEOUT_MS, budgetLeft(startedAt)),
    wait: NAV_WAIT,
  });
  await Bun.sleep(800);
  if (budgetLeft(startedAt) < 5_000) return;
  await client.pageReload(0, {
    timeoutMs: Math.min(NAV_TIMEOUT_MS, budgetLeft(startedAt)),
    wait: NAV_WAIT,
  });
  await Bun.sleep(1200);
}

/**
 * chrome-error 上执行「一次刷新」：先等自动刷新拍，仍停在错误页再主动 reload。
 * 返回 true 表示本拍后已离开错误页或页面就绪；false 表示仍停在 chrome-error。
 */
async function refreshChromeErrorOnce(
  client: XportBrowserClient,
  videoUrl: string,
  startedAt: number,
  refreshIndex: number,
): Promise<boolean> {
  client.taskLog(
    `chrome-error refresh ${refreshIndex}/${CHROME_ERROR_MAX_REFRESHES} → wait ${CHROME_ERROR_REFRESH_WAIT_MS}ms`,
  );
  await Bun.sleep(CHROME_ERROR_REFRESH_WAIT_MS);
  if (await pageLooksReady(client)) return true;
  if (!(await isChromeErrorPage(client))) return true;
  if (budgetLeft(startedAt) < 5_000) return false;

  // 奇数次主动 reload，偶数次再导航（避免只 reload 仍卡死）
  if (refreshIndex % 2 === 0) {
    client.taskLog(`chrome-error refresh ${refreshIndex} → re-open video`);
    const [goOk, goMsg] = await client.pageGoTo(0, {
      url: videoUrl,
      timeoutMs: Math.min(NAV_TIMEOUT_MS, budgetLeft(startedAt)),
      wait: NAV_WAIT,
    });
    if (!goOk) client.taskLog(`re-open soft-fail: ${goMsg || 'unknown'}`);
  } else {
    client.taskLog(`chrome-error refresh ${refreshIndex} → reload`);
    const [reloadOk, reloadMsg] = await client.pageReload(0, {
      timeoutMs: Math.min(NAV_TIMEOUT_MS, budgetLeft(startedAt)),
      wait: NAV_WAIT,
    });
    if (!reloadOk) client.taskLog(`reload soft-fail: ${reloadMsg || 'unknown'}`);
  }
  await Bun.sleep(800);
  if (await pageLooksReady(client)) return true;
  return !(await isChromeErrorPage(client));
}

async function openVideoWithRecovery(
  client: XportBrowserClient,
  videoUrl: string,
): Promise<AutomationRunResult | null> {
  const startedAt = Date.now();
  client.taskLog(
    `openVideo start budgetMs=${OPEN_BUDGET_MS} navTimeoutMs=${NAV_TIMEOUT_MS} chromeErrorMaxRefresh=${CHROME_ERROR_MAX_REFRESHES}`,
  );
  const [goOk, goMsg] = await client.pageGoTo(0, {
    url: videoUrl,
    timeoutMs: NAV_TIMEOUT_MS,
    wait: NAV_WAIT,
  });
  if (!goOk) {
    // 超时 / 瞬断后仍可能已落到错误页或半加载页，继续走恢复（受墙钟预算约束）
    client.taskLog(`pageGoTo soft-fail: ${goMsg || 'unknown'} → try recovery`);
  }
  await Bun.sleep(800);

  // 慢网：视频壳常先出来，评论入口晚挂载——先等最多 ~10s，勿立刻 reload 判失败。
  // chrome-error 不走这段，交给下面「最多 10 次刷新」。
  if (!(await pageLooksReady(client)) && !(await isChromeErrorPage(client))) {
    const waitMs = Math.min(COMMENT_ENTRY_WAIT_MS, Math.max(0, budgetLeft(startedAt) - 5_000));
    if (waitMs >= COMMENT_ENTRY_POLL_MS) {
      await waitForCommentEntry(client, waitMs);
    }
  }

  let chromeErrorRefreshes = 0;
  // chrome-error：严格计刷新次数，满 10 次仍失败 → 网络问题；其它错误页 / 慢加载另开轮次。
  for (let i = 0; i < OPEN_RECOVERY_ROUNDS + CHROME_ERROR_MAX_REFRESHES; i++) {
    if (await pageLooksReady(client)) break;
    if (budgetLeft(startedAt) < 5_000) {
      client.taskLog(`openVideo budget exhausted after ${Date.now() - startedAt}ms`);
      break;
    }
    if (await isChromeErrorPage(client)) {
      if (chromeErrorRefreshes >= CHROME_ERROR_MAX_REFRESHES) {
        client.taskLog(
          `chrome-error reached max refreshes=${CHROME_ERROR_MAX_REFRESHES} → network fail`,
        );
        break;
      }
      chromeErrorRefreshes += 1;
      await refreshChromeErrorOnce(client, videoUrl, startedAt, chromeErrorRefreshes);
      continue;
    }
    if (await isErrorLandingPage(client)) {
      await hardRefreshRecovery(client, videoUrl, startedAt);
      continue;
    }
    // 非错误页：再等一轮评论入口（最多 10s），不轻率 reload 打断加载。
    client.taskLog('video shell loading → wait comment entry again');
    const waitMs = Math.min(COMMENT_ENTRY_WAIT_MS, budgetLeft(startedAt) - 5_000);
    if (waitMs < COMMENT_ENTRY_POLL_MS) break;
    await waitForCommentEntry(client, waitMs);
  }

  if (!(await pageLooksReady(client))) {
    const chromeErr = await isChromeErrorPage(client);
    const hitRefreshCap = chromeErrorRefreshes >= CHROME_ERROR_MAX_REFRESHES;
    const msg =
      chromeErr || looksLikeNavHardFail(goMsg) || hitRefreshCap
        ? `打开视频失败（网络/代理不可达，已刷新 ${chromeErrorRefreshes || CHROME_ERROR_MAX_REFRESHES} 次仍失败：${goMsg || 'chrome-error'}）`
        : goOk
          ? 'TikTok 视频页未就绪（错误页或评论入口未出现）'
          : goMsg || 'pageGoTo failed and page not ready';
    const [, , captured] = await client.captureIncident({
      step: 'recover_error_page',
      reason: msg,
      code: 'NAV_FAILED',
      labels: { videoUrl, chromeErrorRefreshes: String(chromeErrorRefreshes) },
    });
    return skipTaskAsSuccess(msg, {
      code: 'NAV_FAILED',
      step: 'recover_error_page',
      incidentId: captured?.incidentId,
      labels: { videoUrl, chromeErrorRefreshes: String(chromeErrorRefreshes) },
    });
  }

  return null;
}

async function commentsListVisible(client: XportBrowserClient): Promise<number> {
  const [, , n] = await client.getNodeCount(0, pathCommentUsername());
  return n ?? 0;
}

/** 验证码 / 拼图（须人工；禁脚本硬过）。 */
async function isCaptchaVisible(client: XportBrowserClient): Promise<boolean> {
  const js = `(() => {
    const t = (document.body && document.body.innerText) || '';
    if (/Drag the slider to fit the puzzle/i.test(t)) return true;
    if (/拖动滑块|请完成安全验证|Verify to continue/i.test(t)) return true;
    if (document.querySelector('iframe[src*="captcha"], [class*="captcha-disable-scroll"], [id*="captcha-verify"]')) return true;
    return false;
  })()`;
  const [ok, , raw] = await client.evaluateInPage(0, js);
  return ok && raw === 'true';
}

/** 切到 Comments 后骨架屏常先出，等真实 username 挂载。 */
async function waitForCommentUsernames(
  client: XportBrowserClient,
  waitMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isCaptchaVisible(client)) {
      client.taskLog('captcha visible while waiting comments');
      return 0;
    }
    const n = await commentsListVisible(client);
    if (n >= 1) return n;
    await Bun.sleep(500);
  }
  return commentsListVisible(client);
}

/**
 * 打开评论前暂停视频，避免播完自动滑到下一条、评论采集条数不够。
 *
 * 现场：点 `[data-e2e=feed-video]` 可暂停，但网页版常会干扰右侧 Comments 栏
 *（tab 点了列表仍不出现）。故主路径用 video.pause()+loop，效果同「停住不往下翻」，
 * 且不碰评论区布局。采集循环内继续 keepVideoPaused。
 */
async function pauseVideoBeforeComments(client: XportBrowserClient): Promise<void> {
  client.taskLog('pause video before comments (js pause+loop)');
  await keepVideoPaused(client);
  await Bun.sleep(400);
}

/** 强制暂停所有 video 并 loop；采集下滑过程中定期调用，防止播完自动切下一条。 */
async function keepVideoPaused(client: XportBrowserClient): Promise<void> {
  const js = `(() => {
    let n = 0;
    for (const v of document.querySelectorAll('video')) {
      try {
        if (!v.paused) { v.pause(); n++; }
        v.loop = true;
      } catch (_) {}
    }
    return String(n);
  })()`;
  const [ok, msg, raw] = await client.evaluateInPage(0, js);
  if (!ok) {
    client.taskLog(`keepVideoPaused evaluate failed: ${msg || 'unknown'}`);
    return;
  }
  client.taskLog(`keepVideoPaused ok forcedPause=${raw ?? '?'}`);
}

/** 当前 URL 是否仍是目标视频（播完自动下滑会换 id）。 */
function sameVideoUrl(current: string | null | undefined, target: string): boolean {
  const cur = (current || '').trim().split('?')[0]!.toLowerCase();
  const want = target.trim().split('?')[0]!.toLowerCase();
  if (!cur || !want) return false;
  if (cur === want) return true;
  const id = want.match(/\/video\/(\d+)/)?.[1];
  return !!id && cur.includes(`/video/${id}`);
}

/** 右侧栏若停在「You may like」/推荐，切回 Comments 页签（失败现场常见）。 */
async function switchToCommentsTabIfNeeded(client: XportBrowserClient): Promise<boolean> {
  if ((await commentsListVisible(client)) >= 1) return true;
  // 先结构探测（避免错误 API/文案导致抛错，任务一直停在推荐页不点）
  const [, , relatedCount] = await client.getNodeCount(0, pathRelatedPanel());
  const [, , tabFirstCount] = await client.getNodeCount(0, pathCommentsTabFirst());
  if ((relatedCount ?? 0) < 1 && (tabFirstCount ?? 0) < 1) {
    return false;
  }
  let tabByTextCount = 0;
  try {
    const [, , n] = await client.getNodeCount(0, pathCommentsTab());
    tabByTextCount = n ?? 0;
  } catch (e) {
    client.taskLog(`pathCommentsTab probe skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 现场：containAnyText 文案路径偶发点了不切换（related 仍在）；结构第一个页签=Comments 更稳。
  // 先点 first，失败再试文案路径。
  const pathsToTry = [
    { name: 'tabFirst', path: pathCommentsTabFirst(), ok: (tabFirstCount ?? 0) >= 1 },
    { name: 'tabText', path: pathCommentsTab(), ok: tabByTextCount >= 1 },
  ].filter((p) => p.ok);

  for (const cand of pathsToTry) {
    client.taskLog(
      `right panel not on comments related=${relatedCount ?? 0} tabText=${tabByTextCount} tabFirst=${tabFirstCount ?? 0} → click ${cand.name}`,
    );
    const [clickOk, clickMsg] = await client.clickNode(0, cand.path);
    if (!clickOk) {
      client.taskLog(`click ${cand.name} failed: ${clickMsg || 'unknown'}`);
      continue;
    }
    await Bun.sleep(800);
    if ((await waitForCommentUsernames(client, 12_000)) >= 1) return true;
  }
  return (await commentsListVisible(client)) >= 1;
}

async function ensureCommentsOpen(client: XportBrowserClient, videoUrl: string): Promise<AutomationRunResult | null> {
  // 先暂停：播完会自动滑下一条，评论区随之丢失，采集条数不够。
  await pauseVideoBeforeComments(client);

  if (await isCaptchaVisible(client)) {
    const msg = '出现安全验证（拖动拼图），请在该浏览器人工完成后再重跑';
    const [, , captured] = await client.captureIncident({
      step: 'open_comments',
      reason: msg,
      code: 'CAPTCHA',
      labels: { videoUrl },
    });
    return skipTaskAsSuccess(msg, {
      code: 'CAPTCHA',
      step: 'open_comments',
      incidentId: captured?.incidentId,
      labels: { videoUrl },
    });
  }

  let entry = await probeCommentEntry(client);
  if (entry === 'list') {
    client.taskLog('comments already open');
    return null;
  }

  // 入口未齐：等最多 ~10s，一出现就往下点（慢网常见骨架页）。
  if (!entry) {
    entry = await waitForCommentEntry(client, COMMENT_ENTRY_WAIT_MS);
  }
  if (entry === 'list') {
    client.taskLog('comments opened while waiting');
    return null;
  }

  // 右侧栏页签/推荐区已出（常停在 You may like）：立刻点 Comments。
  if (await switchToCommentsTabIfNeeded(client)) {
    client.taskLog('comments opened via Comments tab');
    return null;
  }

  // 仍无列表：再等 icon，出来立刻点。
  entry = await probeCommentEntry(client);
  if (entry !== 'icon') {
    entry = await waitForCommentEntry(client, COMMENT_ENTRY_WAIT_MS);
    if (entry === 'list') return null;
    if (await switchToCommentsTabIfNeeded(client)) {
      client.taskLog('comments opened via Comments tab after wait');
      return null;
    }
  }

  const [iconOk, , iconCount] = await client.getNodeCount(0, pathCommentIcon());
  if (!iconOk || (iconCount ?? 0) < 1) {
    const msg = '未找到评论入口（按钮/页签），请确认已打开视频页';
    const [, , captured] = await client.captureIncident({
      step: 'find_comment_icon',
      reason: msg,
      code: 'ELEMENT_NOT_FOUND',
      labels: { videoUrl },
    });
    return skipTaskAsSuccess(msg, {
      code: 'ELEMENT_NOT_FOUND',
      step: 'find_comment_icon',
      incidentId: captured?.incidentId,
      labels: { videoUrl },
    });
  }

  client.taskLog('click comment-icon');
  const [clickOk, clickMsg] = await client.clickNode(0, pathCommentIcon());
  if (!clickOk) {
    const msg = clickMsg || '点击评论按钮失败';
    const [, , captured] = await client.captureIncident({
      step: 'open_comments',
      reason: msg,
      code: 'ELEMENT_NOT_FOUND',
      labels: { videoUrl },
    });
    return skipTaskAsSuccess(msg, {
      code: 'ELEMENT_NOT_FOUND',
      step: 'open_comments',
      incidentId: captured?.incidentId,
      labels: { videoUrl },
    });
  }
  await Bun.sleep(900);

  const afterIcon = await waitForCommentUsernames(client, 12_000);
  if (afterIcon >= 1) {
    client.taskLog(`comments opened count=${afterIcon}`);
    return null;
  }

  // 点 comment-icon 后仍可能落在「You may like」：再切 Comments 页签。
  if (await switchToCommentsTabIfNeeded(client)) {
    client.taskLog('comments opened after icon + Comments tab');
    return null;
  }

  if (await isCaptchaVisible(client)) {
    const msg = '出现安全验证（拖动拼图），请在该浏览器人工完成后再重跑';
    const [, , captured] = await client.captureIncident({
      step: 'wait_comments_list',
      reason: msg,
      code: 'CAPTCHA',
      labels: { videoUrl },
    });
    return skipTaskAsSuccess(msg, {
      code: 'CAPTCHA',
      step: 'wait_comments_list',
      incidentId: captured?.incidentId,
      labels: { videoUrl },
    });
  }

  const msg = '点击评论后未出现评论列表';
  const [, , captured] = await client.captureIncident({
    step: 'wait_comments_list',
    reason: msg,
    code: 'ELEMENT_NOT_FOUND',
    labels: { videoUrl },
  });
  return skipTaskAsSuccess(msg, {
    code: 'ELEMENT_NOT_FOUND',
    step: 'wait_comments_list',
    incidentId: captured?.incidentId,
    labels: { videoUrl },
  });
}

async function scrapeVisibleComments(client: XportBrowserClient): Promise<ScrapedComment[]> {
  const js = `(() => {
    const list = document.querySelector('[class*="DivCommentListContainer"]');
    if (!list) return '[]';
    const items = list.querySelectorAll('[class*="DivCommentItemWrapper"]');
    const rows = [];
    for (const item of items) {
      const a = item.querySelector('[data-e2e="comment-username-1"] a[href*="/@"]');
      if (!a) continue;
      const contentEl = item.querySelector('[data-e2e="comment-level-1"]');
      const dateEl = item.querySelector('[class*="DivCommentSubContentWrapper"] > span');
      const href = a.getAttribute('href') || '';
      rows.push({
        userName: (a.textContent || '').trim(),
        profileUrl: href,
        commentContent: (contentEl?.textContent || '').trim(),
        commentDate: (dateEl?.textContent || '').trim(),
      });
    }
    return JSON.stringify(rows);
  })()`;
  const [ok, msg, raw] = await client.evaluateInPage(0, js);
  if (!ok || !raw) {
    client.taskLog(`scrapeVisibleComments failed: ${msg || 'empty'}`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as ScrapedComment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    client.taskLog('scrapeVisibleComments JSON parse failed');
    return [];
  }
}

async function scrollCommentsForMore(client: XportBrowserClient): Promise<void> {
  // 现场：小幅 scrollTop+=360 常不触发懒加载；须贴底（scrollTop=scrollHeight）再等高度上涨。
  const stickBottomJs = `(() => {
    const main = document.querySelector('[class*="DivCommentMain"]');
    if (!main) return '{"ok":false}';
    const beforeSh = main.scrollHeight;
    const beforeSt = main.scrollTop;
    main.scrollTop = main.scrollHeight;
    return JSON.stringify({
      ok: true,
      beforeSt: Math.round(beforeSt),
      afterSt: Math.round(main.scrollTop),
      beforeSh,
      afterSh: main.scrollHeight,
    });
  })()`;

  const [evalOk, evalMsg, raw] = await client.evaluateInPage(0, stickBottomJs);
  if (!evalOk) {
    client.taskLog(`scrollComments evaluate soft-fail: ${evalMsg || 'unknown'}`);
  } else {
    client.taskLog(`scrollComments stickBottom ${raw || ''}`);
  }

  // 再用 wheel 补一次滚动事件（部分布局只认 wheel）
  const lastVisible = pathCommentItemLastVisible();
  const [hoverOk] = await client.hoverNode(0, lastVisible);
  if (hoverOk) {
    await Bun.sleep(150);
    await client.mouseWheel(0, lastVisible, { deltaY: 680 });
  }
  await client.mouseWheel(0, pathCommentScrollMain(), { deltaY: 720 });

  // 懒加载：贴底后等新评论挂载，再补贴一次底
  await Bun.sleep(1200);
  await client.evaluateInPage(0, stickBottomJs);
  await Bun.sleep(700);
  await client.waitForDomQuiet(0, {
    timeoutMs: 3500,
    stableMs: 450,
    selector: '[class*="DivCommentListContainer"]',
  });
}

async function runAutomation(client: XportBrowserClient, taskConfig: TaskRunConfig): Promise<AutomationRunResult> {
  const videoUrl = String(taskConfig.videoUrl ?? '').trim();
  const maxComments = parseMaxComments(taskConfig.maxComments, 100);
  client.taskLog(`videoUrl=${videoUrl || '(empty)'} maxComments=${maxComments}`);

  if (!videoUrl) {
    return skipTaskAsSuccess('videoUrl is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_video_url',
    });
  }

  const openFail = await openVideoWithRecovery(client, videoUrl);
  if (openFail) return openFail;

  const commentsFail = await ensureCommentsOpen(client, videoUrl);
  if (commentsFail) return commentsFail;

  const seenComments = new Set<string>();
  let collectedCount = 0;
  let stagnantRounds = 0;
  // 滚错容器时 4 轮就会停在十几条；正确滚 DivCommentMain 后仍可能短暂停顿，放宽到 8。
  const maxStagnant = 8;
  const maxScrollRounds = Math.max(60, maxComments * 2 + 20);

  for (let round = 0; round < maxScrollRounds; round++) {
    // 下滑采集中保持暂停，并检测是否已自动滑到下一条视频。
    await keepVideoPaused(client);
    const [, , curUrl] = await client.getPageUrl();
    if (!sameVideoUrl(curUrl, videoUrl)) {
      client.taskLog(`video advanced away: ${curUrl || '(empty)'} → re-open`);
      const reopenFail = await openVideoWithRecovery(client, videoUrl);
      if (reopenFail) return reopenFail;
      const reopenComments = await ensureCommentsOpen(client, videoUrl);
      if (reopenComments) return reopenComments;
      stagnantRounds = 0;
      continue;
    }

    const batch = await scrapeVisibleComments(client);
    const fresh: IntermediateDataRow[] = [];
    for (const row of batch) {
      const profileUrl = absolutizeProfileUrl(row.profileUrl);
      const normalized: ScrapedComment = {
        userName: row.userName.trim(),
        profileUrl,
        commentContent: row.commentContent.trim(),
        commentDate: row.commentDate.trim(),
      };
      if (!normalized.profileUrl || !normalized.commentContent) continue;
      const key = commentDedupeKey(normalized.profileUrl);
      if (seenComments.has(key)) continue;
      seenComments.add(key);
      fresh.push(normalized);
      if (seenComments.size >= maxComments) break;
    }

    if (fresh.length > 0) {
      const [ingOk, ingMsg] = await client.ingestIntermediate(fresh);
      if (!ingOk) {
        const msg = ingMsg || 'ingestIntermediate failed';
        const [, , captured] = await client.captureIncident({
          step: 'ingest_comments',
          reason: msg,
          code: 'UNKNOWN',
          labels: { videoUrl, batch: String(fresh.length) },
        });
        return skipTaskAsSuccess(msg, {
          code: 'UNKNOWN',
          step: 'ingest_comments',
          incidentId: captured?.incidentId,
          labels: { videoUrl },
        });
      }
      collectedCount += fresh.length;
      stagnantRounds = 0;
      client.taskLog(`ingested +${fresh.length} total=${collectedCount} round=${round + 1}`);
    } else {
      stagnantRounds += 1;
      client.taskLog(`no fresh comments stagnant=${stagnantRounds}/${maxStagnant} round=${round + 1}`);
    }

    if (collectedCount >= maxComments) {
      client.taskLog(`reached maxComments=${maxComments}`);
      break;
    }
    if (stagnantRounds >= maxStagnant) {
      client.taskLog(`stop: stagnantRounds=${stagnantRounds} collected=${collectedCount}`);
      break;
    }

    await scrollCommentsForMore(client);
  }

  const [, , finalUrl] = await client.getPageUrl();
  return {
    succ: true,
    msg: `采集完成，共 ${collectedCount} 条评论`,
    data: {
      videoUrl,
      collectedCount,
      finalUrl: finalUrl || videoUrl,
    },
  };
}

const manifest = await loadAutomationManifest();
if (manifest.intermediateDataSchema) {
  const [prepOk, prepMsg] = await prepareIntermediateStorage(manifest);
  if (!prepOk) {
    process.exit(
      await XportBrowserClient.run(async () =>
        skipTaskAsSuccess(prepMsg || 'prepareIntermediateStorage failed', {
          code: 'UNKNOWN',
          step: 'prepare_storage',
        }),
      ),
    );
  }
}

const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(
  await XportBrowserClient.run(async (client) => {
    try {
      return await runAutomation(client, taskConfig);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const [, , captured] = await client.captureIncident({
        step: 'uncaught',
        reason,
        code: 'UNKNOWN',
      });
      return skipTaskAsSuccess(reason, {
        code: 'UNKNOWN',
        step: 'uncaught',
        incidentId: captured?.incidentId,
      });
    }
  }),
);
