/**
 * TikTok 批量自动关注：打开指定用户主页 → 点击关注（已关注则幂等成功）。
 * 定位：主页头图下方 `DivButtonPanelWrapper` 内的 follow-button（勿用裸 follow-button：
 * Suggested accounts 卡片也会挂 follow-button，DOM 序可能先于主按钮）。
 * 已关注态仍为 follow-button，文案/aria-label 为现场观察到的 Following。
 * 主页常先出 SSR/骨架屏（side-nav-skeleton），关注按钮晚于 user-page 水合；
 * 须加长等待；仍无按钮时刷新一次再等。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  type NodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const FOLLOW_BTN = nodePath()
  .css(
    '[data-e2e="user-page"] [class*="DivButtonPanelWrapper"] button[data-e2e="follow-button"]',
  )
  .one();
const USER_PAGE = nodePath().css('[data-e2e="user-page"]').one();
const SIDE_NAV_SKELETON = nodePath().css('[data-e2e="side-nav-skeleton"]').one();
const TOP_LOGIN = nodePath().css('button[data-e2e="top-login-button"]').one();
const LOGIN_MODAL = nodePath().css('[data-e2e="login-modal"]').one();
const CAPTCHA = nodePath().css('#tiktok-verify-ele iframe, #tiktok-verify-ele [class*="captcha"]').one();

/** 现场英文 UI 已观察：未关注 Follow / Follow back；已关注 Following（aria-label 同前缀） */
const TEXT_FOLLOWING = 'Following';
const FOLLOW_BTN_WAIT_MS = 45_000;

/**
 * 原失败出口统一收口：仍 capture 现场，但任务标成功（跳过语义）。
 * msg 文案保持与原先失败提示一致，便于工作流侧查看原因。
 */
async function failStep(
  client: XportBrowserClient,
  reason: string,
  opts: { code: string; step: string; labels?: Record<string, string> },
): Promise<AutomationRunResult> {
  await client.captureIncident({
    step: opts.step,
    reason,
    code: opts.code,
    labels: opts.labels,
  });
  return { succ: true, msg: reason };
}

/** 无页面态时的软跳过（如参数校验），不 capture。 */
function softSkip(reason: string): AutomationRunResult {
  return { succ: true, msg: reason };
}

function normalizeProfileUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // 拒绝占位文案
  if (/主页链接|profile\s*url|placeholder/i.test(trimmed) && !trimmed.includes('@')) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.includes('tiktok.com')) return null;
  const m = url.pathname.match(/^\/@([^/?#]+)/);
  if (!m?.[1]) return null;
  let username = m[1];
  try {
    username = decodeURIComponent(username);
  } catch {
    /* keep */
  }
  return `https://www.tiktok.com/@${username}`;
}

async function count(client: XportBrowserClient, path: NodePath): Promise<number> {
  const [ok, , n] = await client.getNodeCount(0, path);
  return ok && typeof n === 'number' ? n : 0;
}

async function waitCount(
  client: XportBrowserClient,
  path: NodePath,
  min: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await count(client, path);
    if (last >= min) return last;
    await Bun.sleep(500);
  }
  return last;
}

async function readFollowButtonState(
  client: XportBrowserClient,
): Promise<{ text: string; ariaLabel: string } | null> {
  const [ok, msg, data] = await client.getNodeData(0, FOLLOW_BTN, ['text', 'attribute:aria-label']);
  if (!ok || !data) {
    client.taskLog(`readFollowButtonState failed: ${msg || 'empty'}`);
    return null;
  }
  const text = String(data.text?.[0] ?? '').trim();
  const ariaLabel = String(data['attribute:aria-label']?.[0] ?? '').trim();
  return { text, ariaLabel };
}

/** 已关注：可见文案或 aria-label 为现场观察到的 Following 前缀 */
function isAlreadyFollowing(state: { text: string; ariaLabel: string }): boolean {
  if (state.text === TEXT_FOLLOWING) return true;
  if (/^Following(\s|$)/i.test(state.ariaLabel)) return true;
  return false;
}

/** 未关注：现场观察到的 Follow / Follow back（非 Following） */
function isUnfollowed(state: { text: string; ariaLabel: string }): boolean {
  if (isAlreadyFollowing(state)) return false;
  // 可见文案：Follow 或 Follow back
  if (/^Follow(\s+back)?$/i.test(state.text)) return true;
  if (/^Follow(\s|$)/i.test(state.ariaLabel) && !/^Following/i.test(state.ariaLabel)) return true;
  return false;
}

/** 等待主页关注按钮水合；骨架屏卡住时刷新一次再等 */
async function waitFollowButtonHydrated(
  client: XportBrowserClient,
  labels: Record<string, string>,
): Promise<AutomationRunResult | null> {
  let followReady = await waitCount(client, FOLLOW_BTN, 1, FOLLOW_BTN_WAIT_MS);
  if (followReady >= 1) return null;

  const blocked = await detectBlockers(client, labels);
  if (blocked) return blocked;

  const skeletonLeft = (await count(client, SIDE_NAV_SKELETON)) >= 1;
  client.taskLog(
    `follow button missing after ${FOLLOW_BTN_WAIT_MS}ms skeleton=${skeletonLeft} — reload once`,
  );
  const [reloadOk, reloadMsg] = await client.pageReload(0);
  if (!reloadOk) {
    return failStep(client, reloadMsg || '主页刷新失败，关注按钮未出现', {
      code: 'NAV_FAILED',
      step: 'reload_for_follow_button',
      labels,
    });
  }
  await Bun.sleep(1000);

  const blockedAfterReload = await detectBlockers(client, labels);
  if (blockedAfterReload) return blockedAfterReload;

  const pageReady = await waitCount(client, USER_PAGE, 1, 45_000);
  if (pageReady < 1) {
    return failStep(client, '刷新后主页未加载完成（未找到用户主页区域）', {
      code: 'TIMEOUT',
      step: 'wait_user_page_after_reload',
      labels,
    });
  }

  followReady = await waitCount(client, FOLLOW_BTN, 1, FOLLOW_BTN_WAIT_MS);
  if (followReady >= 1) return null;

  const blockedFinal = await detectBlockers(client, labels);
  if (blockedFinal) return blockedFinal;

  return failStep(client, '未找到主页关注按钮（可能是自己的主页或页面结构变化）', {
    code: 'ELEMENT_NOT_FOUND',
    step: 'wait_follow_button',
    labels,
  });
}

async function detectBlockers(
  client: XportBrowserClient,
  labels: Record<string, string>,
): Promise<AutomationRunResult | null> {
  if ((await count(client, CAPTCHA)) >= 1) {
    return failStep(client, '人机验证出现，请先在浏览器内完成验证后重试', {
      code: 'CAPTCHA',
      step: 'detect_captcha',
      labels,
    });
  }
  if ((await count(client, TOP_LOGIN)) >= 1 || (await count(client, LOGIN_MODAL)) >= 1) {
    return failStep(client, '账号未登录 TikTok，请先登录后再运行', {
      code: 'NOT_LOGGED_IN',
      step: 'detect_login',
      labels,
    });
  }
  const [, , title] = await client.getPageTitle();
  if (typeof title === 'string' && /log\s*in/i.test(title)) {
    return failStep(client, '账号未登录 TikTok，请先登录后再运行', {
      code: 'NOT_LOGGED_IN',
      step: 'detect_login_title',
      labels,
    });
  }
  return null;
}

async function runAutomation(client: XportBrowserClient, taskConfig: TaskRunConfig): Promise<AutomationRunResult> {
  const hostRaw = String(taskConfig.host ?? '').trim();
  client.taskLog(`host=${hostRaw || '(empty)'}`);

  const host = normalizeProfileUrl(hostRaw);
  if (!host) {
    return softSkip(
      '请填写有效的 TikTok 用户主页链接（如 https://www.tiktok.com/@username）',
    );
  }
  const labels = { host };

  try {
    const [goOk, goMsg] = await client.pageGoTo(0, { url: host, timeoutMs: 60_000 });
    if (!goOk) {
      return failStep(client, goMsg || '打开主页失败', {
        code: 'NAV_FAILED',
        step: 'open_host',
        labels,
      });
    }
    client.taskLog('pageGoTo ok');
    await Bun.sleep(800);

    const blockedEarly = await detectBlockers(client, labels);
    if (blockedEarly) return blockedEarly;

    const pageReady = await waitCount(client, USER_PAGE, 1, 45_000);
    if (pageReady < 1) {
      return failStep(client, '主页未加载完成（未找到用户主页区域）', {
        code: 'TIMEOUT',
        step: 'wait_user_page',
        labels,
      });
    }

    const hydrateFail = await waitFollowButtonHydrated(client, labels);
    if (hydrateFail) return hydrateFail;

    await Bun.sleep(600);
    const before = await readFollowButtonState(client);
    if (!before) {
      return failStep(client, '无法读取关注按钮状态', {
        code: 'ELEMENT_NOT_FOUND',
        step: 'read_follow_state',
        labels,
      });
    }
    client.taskLog(`follow_state before text=${before.text} aria=${before.ariaLabel}`);

    const [, , finalUrlBefore] = await client.getPageUrl();

    if (isAlreadyFollowing(before)) {
      client.taskLog('already following — idempotent success');
      return {
        succ: true,
        msg: 'already following',
        data: {
          host,
          follow_status: 'already_following',
          finalUrl: finalUrlBefore || host,
        },
      };
    }

    if (!isUnfollowed(before)) {
      return failStep(
        client,
        `无法识别关注按钮状态（text=${before.text || '?'} aria=${before.ariaLabel || '?'}）`,
        {
          code: 'UI_LANGUAGE_MISMATCH',
          step: 'parse_follow_state',
          labels: { ...labels, text: before.text, aria: before.ariaLabel },
        },
      );
    }

    const [clickOk, clickMsg] = await client.clickNode(0, FOLLOW_BTN);
    if (!clickOk) {
      return failStep(client, clickMsg || '点击关注失败', {
        code: 'ELEMENT_NOT_FOUND',
        step: 'click_follow',
        labels,
      });
    }
    await Bun.sleep(1200);

    const blockedAfter = await detectBlockers(client, labels);
    if (blockedAfter) return blockedAfter;

    let after: { text: string; ariaLabel: string } | null = null;
    for (let i = 0; i < 10; i++) {
      after = await readFollowButtonState(client);
      if (after && isAlreadyFollowing(after)) break;
      await Bun.sleep(500);
    }

    if (!after || !isAlreadyFollowing(after)) {
      return failStep(client, '已点击关注，但未变为已关注状态', {
        code: 'TIMEOUT',
        step: 'verify_followed',
        labels: {
          ...labels,
          text: after?.text || '',
          aria: after?.ariaLabel || '',
        },
      });
    }

    const [, , finalUrl] = await client.getPageUrl();
    client.taskLog(`followed ok text=${after.text}`);
    return {
      succ: true,
      msg: 'followed',
      data: {
        host,
        follow_status: 'followed',
        finalUrl: finalUrl || host,
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return failStep(client, reason || 'unexpected error', {
      code: 'UNKNOWN',
      step: 'run_automation_catch',
      labels,
    });
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
