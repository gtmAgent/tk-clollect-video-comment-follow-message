/**
 * TikTok 批量私信：打开对方主页 → 点消息 → 随机文案 + 可选附件发送；
 * 未登录 / 网络异常 / 非主页链接 → 跳过；其它可重试直到发出；
 * 红色感叹号（data-e2e=dm-warning）→ 跳过。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  type NodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const MSG_SEP = '==sep==';
/** 单次任务内最多尝试轮数（仿人工间隔，避免无限循环） */
const MAX_SEND_ATTEMPTS = 8;

const SEL = {
  messageBtn: nodePath().css('button[data-e2e="message-button"]').one(),
  dmInput: nodePath().css('[data-e2e="dm-new-input-editor"] [contenteditable="true"]').one(),
  sendBtn: nodePath().css('[data-e2e="dm-new-send-btn"]').one(),
  dmWarning: nodePath().css('[data-e2e="dm-warning"]').one(),
  chatBox: nodePath().css('[data-e2e="dm-new-chatbox"]').one(),
  mediaModal: nodePath().css('[data-e2e="dm-new-select-media-modal"]').one(),
  mediaSendBtn: nodePath().css('[data-e2e="dm-new-select-media-modal"] button').one(),
  topLoginBtn: nodePath().css('button[data-e2e="top-login-button"]').one(),
  loginModal: nodePath().css('[data-e2e="login-modal"]').one(),
  captchaHost: nodePath().css('#tiktok-verify-ele iframe, #tiktok-verify-ele [class*="captcha"]').one(),
};

type SkipStatus =
  | 'skipped_not_logged_in'
  | 'skipped_network'
  | 'skipped_invalid_host'
  | 'skipped_captcha'
  | 'skipped_warning';

/** 步骤内部控制：跳过 / 本轮重试 / 硬失败 / 继续 */
type StepCtrl =
  | { kind: 'ok' }
  | { kind: 'skip'; status: SkipStatus; msg: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'fail'; step: string; reason: string; code: string; labels?: Record<string, string> };

function pickRandomMessage(raw: string): string {
  const parts = raw
    .split(MSG_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const idx = Math.floor(Math.random() * parts.length);
  return parts[idx]!;
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

function skipResult(
  host: string,
  messageSent: string,
  status: SkipStatus,
  msg: string,
  finalUrl = '',
): AutomationRunResult {
  return {
    succ: true,
    msg,
    data: {
      host,
      message_sent: messageSent,
      status,
      finalUrl,
    },
  };
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step,
    reason,
    code,
    labels,
  });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
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
    await sleep(500);
  }
  return last;
}

function isValidTikTokProfileUrl(host: string): boolean {
  try {
    const u = new URL(host.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostOk = /(^|\.)tiktok\.com$/i.test(u.hostname);
    return hostOk && /\/@[\w.-]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

function looksLikeNetworkError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('err_connection') ||
    m.includes('err_timed_out') ||
    m.includes('err_name_not_resolved') ||
    m.includes('err_proxy') ||
    m.includes('err_tunnel') ||
    m.includes('net::') ||
    m.includes('cannot navigate to invalid url') ||
    m.includes('network') ||
    m.includes('timeout') ||
    m.includes('closed the connection')
  );
}

async function detectAuthOrCaptcha(client: XportBrowserClient): Promise<StepCtrl> {
  if ((await count(client, SEL.captchaHost)) >= 1) {
    return {
      kind: 'skip',
      status: 'skipped_captcha',
      msg: '出现人机验证，已跳过该任务',
    };
  }
  if ((await count(client, SEL.topLoginBtn)) >= 1 || (await count(client, SEL.loginModal)) >= 1) {
    return {
      kind: 'skip',
      status: 'skipped_not_logged_in',
      msg: '账号未登录，已跳过该任务',
    };
  }
  const [, , title] = await client.getPageTitle();
  if (typeof title === 'string' && /log\s*in/i.test(title)) {
    return {
      kind: 'skip',
      status: 'skipped_not_logged_in',
      msg: '账号未登录，已跳过该任务',
    };
  }
  const [, , url] = await client.getPageUrl();
  if (typeof url === 'string' && /chrome-error:|chromewebdata/i.test(url)) {
    return {
      kind: 'skip',
      status: 'skipped_network',
      msg: '网络异常，已跳过该任务',
    };
  }
  return { kind: 'ok' };
}

async function openDmFromProfile(client: XportBrowserClient, host: string): Promise<StepCtrl> {
  const [goOk, goMsg] = await client.pageGoTo(0, { url: host, timeoutMs: 60_000 });
  if (!goOk) {
    const reason = goMsg || '打开主页失败';
    if (looksLikeNetworkError(reason)) {
      return { kind: 'skip', status: 'skipped_network', msg: '网络异常，已跳过该任务' };
    }
    return { kind: 'retry', reason };
  }
  await sleep(1200);

  const authEarly = await detectAuthOrCaptcha(client);
  if (authEarly.kind !== 'ok') return authEarly;

  let msgN = await waitCount(client, SEL.messageBtn, 1, 20_000);
  if (msgN < 1) {
    client.taskLog('message button missing → reload once');
    await client.pageReload(0);
    await sleep(2000);
    const authAfterReload = await detectAuthOrCaptcha(client);
    if (authAfterReload.kind !== 'ok') return authAfterReload;
    msgN = await waitCount(client, SEL.messageBtn, 1, 15_000);
  }
  if (msgN < 1) {
    const authLate = await detectAuthOrCaptcha(client);
    if (authLate.kind !== 'ok') return authLate;
    return { kind: 'retry', reason: '主页未找到消息按钮' };
  }

  const [clickOk, clickMsg] = await client.clickNode(0, SEL.messageBtn);
  if (!clickOk) {
    return { kind: 'retry', reason: clickMsg || '点击消息按钮失败' };
  }
  await sleep(1500);

  const authAfterClick = await detectAuthOrCaptcha(client);
  if (authAfterClick.kind !== 'ok') return authAfterClick;

  const chatN = await waitCount(client, SEL.chatBox, 1, 25_000);
  if (chatN < 1) {
    const authFinal = await detectAuthOrCaptcha(client);
    if (authFinal.kind !== 'ok') return authFinal;
    return { kind: 'retry', reason: '未进入私信会话' };
  }
  return { kind: 'ok' };
}

async function afterSendCheckWarning(client: XportBrowserClient): Promise<StepCtrl> {
  await sleep(1500);
  const warnN = await count(client, SEL.dmWarning);
  if (warnN >= 1) {
    client.taskLog('dm-warning detected → skip');
    return {
      kind: 'skip',
      status: 'skipped_warning',
      msg: '发送失败（红色感叹号），已按规则跳过该任务',
    };
  }
  return { kind: 'ok' };
}

async function sendTextMessage(client: XportBrowserClient, text: string): Promise<StepCtrl> {
  const inputN = await waitCount(client, SEL.dmInput, 1, 15_000);
  if (inputN < 1) {
    return { kind: 'retry', reason: '未找到私信输入框' };
  }

  const [typeOk, typeMsg] = await client.typeInNode(0, SEL.dmInput, text);
  if (!typeOk) {
    return { kind: 'retry', reason: typeMsg || '填入文案失败' };
  }
  await sleep(800);

  const sendN = await waitCount(client, SEL.sendBtn, 1, 10_000);
  if (sendN < 1) {
    return { kind: 'retry', reason: '未出现发送按钮' };
  }

  const [sendOk, sendMsg] = await client.clickNode(0, SEL.sendBtn);
  if (!sendOk) {
    return { kind: 'retry', reason: sendMsg || '点击发送失败' };
  }
  await sleep(1000);
  return { kind: 'ok' };
}

async function sendAttachment(client: XportBrowserClient, md5: string): Promise<StepCtrl> {
  const inputN = await waitCount(client, SEL.dmInput, 1, 10_000);
  if (inputN < 1) {
    return { kind: 'retry', reason: '未找到私信输入框，无法粘贴附件' };
  }

  await client.focusNode(0, SEL.dmInput);
  await sleep(400);

  const [pasteOk, pasteMsg] = await client.pasteClipboardBinary(0, SEL.dmInput, md5);
  if (!pasteOk) {
    return { kind: 'retry', reason: pasteMsg || '粘贴附件失败' };
  }
  await sleep(1500);

  const mediaSendN = await waitCount(client, SEL.mediaSendBtn, 1, 12_000);
  if (mediaSendN >= 1) {
    const [ok, msg] = await client.clickNode(0, SEL.mediaSendBtn, -1, {
      preferClickableAncestor: true,
    });
    if (!ok) {
      return { kind: 'retry', reason: msg || '点击附件发送失败' };
    }
    await sleep(1200);
    return { kind: 'ok' };
  }

  const sendN = await count(client, SEL.sendBtn);
  if (sendN >= 1) {
    const [ok, msg] = await client.clickNode(0, SEL.sendBtn);
    if (!ok) {
      return { kind: 'retry', reason: msg || '附件后点击发送失败' };
    }
    await sleep(1000);
    return { kind: 'ok' };
  }

  return { kind: 'retry', reason: '已粘贴附件但未出现发送预览/发送按钮' };
}

async function attemptSendOnce(
  client: XportBrowserClient,
  host: string,
  messageSent: string,
  attachMd5: string,
): Promise<StepCtrl & { finalUrl?: string }> {
  const openCtrl = await openDmFromProfile(client, host);
  if (openCtrl.kind !== 'ok') return openCtrl;

  const [, , pageUrl] = await client.getPageUrl();
  const finalUrl = pageUrl || '';

  if (messageSent) {
    const textCtrl = await sendTextMessage(client, messageSent);
    if (textCtrl.kind !== 'ok') return textCtrl;
    const warnCtrl = await afterSendCheckWarning(client);
    if (warnCtrl.kind !== 'ok') return { ...warnCtrl, finalUrl };
  }

  if (attachMd5) {
    const attCtrl = await sendAttachment(client, attachMd5);
    if (attCtrl.kind !== 'ok') return attCtrl;
    const warnCtrl = await afterSendCheckWarning(client);
    if (warnCtrl.kind !== 'ok') return { ...warnCtrl, finalUrl };
  }

  const [, , url2] = await client.getPageUrl();
  return { kind: 'ok', finalUrl: url2 || finalUrl };
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  try {
    const host = String(taskConfig.host ?? '').trim();
    const messagesRaw = String(taskConfig.messages ?? '').trim();
    const attachment = taskConfig.attachment;
    const attachMd5 =
      typeof attachment === 'string' && attachment.trim() ? attachment.trim() : '';

    client.taskLog(`host=${host || '(empty)'} attach=${attachMd5 ? 'yes' : 'no'}`);

    if (!host || !isValidTikTokProfileUrl(host)) {
      client.taskLog('invalid host → skip');
      return skipResult(
        host,
        '',
        'skipped_invalid_host',
        '不是有效的 TikTok 主页链接，已跳过该任务',
      );
    }
    if (!messagesRaw && !attachMd5) {
      return automationFailWithContext('请填写私信文案或选择附件（至少一项）', {
        code: 'UNKNOWN',
        step: 'validate_content',
      });
    }

    const messageSent = messagesRaw ? pickRandomMessage(messagesRaw) : '';
    if (messagesRaw && !messageSent) {
      return automationFailWithContext('私信文案为空，请用 ==sep== 分隔多条文案', {
        code: 'UNKNOWN',
        step: 'validate_messages',
      });
    }
    client.taskLog(`picked message len=${messageSent.length}`);

    let lastRetryReason = '';
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      client.taskLog(`send attempt ${attempt}/${MAX_SEND_ATTEMPTS}`);
      const ctrl = await attemptSendOnce(client, host, messageSent, attachMd5);

      if (ctrl.kind === 'skip') {
        return skipResult(host, messageSent, ctrl.status, ctrl.msg, ctrl.finalUrl || '');
      }
      if (ctrl.kind === 'ok') {
        return {
          succ: true,
          msg: '私信发送完成',
          data: {
            host,
            message_sent: messageSent,
            status: 'sent',
            finalUrl: ctrl.finalUrl || '',
          },
        };
      }
      if (ctrl.kind === 'fail') {
        return failStep(client, ctrl.step, ctrl.reason, ctrl.code, ctrl.labels);
      }

      // retry
      lastRetryReason = ctrl.reason;
      client.taskLog(`retry: ${ctrl.reason}`);
      await sleep(1500 + Math.min(attempt, 5) * 400);
    }

    return failStep(
      client,
      'send_exhausted',
      `已重试 ${MAX_SEND_ATTEMPTS} 次仍未发出：${lastRetryReason || '未知原因'}`,
      'ELEMENT_NOT_FOUND',
      { host },
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (looksLikeNetworkError(reason)) {
      const host = String(taskConfig.host ?? '').trim();
      return skipResult(host, '', 'skipped_network', '网络异常，已跳过该任务');
    }
    const [, , captured] = await client.captureIncident({
      step: 'unexpected_error',
      reason,
      code: 'UNKNOWN',
    });
    return automationFailWithContext(reason || '未预期异常', {
      code: 'UNKNOWN',
      step: 'unexpected_error',
      incidentId: captured?.incidentId,
    });
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
