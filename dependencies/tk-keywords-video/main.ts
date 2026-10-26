/**
 * TikTok 关键词搜索结果采集：视频链接、文案、发布日期、点赞数。
 *
 * 环境变量：`DESKTOP_PORT`、`SDK_PATH`、`DEVICE_ID`、`LISTEN_PORT`、`TASK_ID`（或试跑 `RUN_CONFIG_KEY`）、
 * `AUTOMATION_CMD`、`SOCIAL_NAME`、`SOCIAL_HOME`、`CDP_URL`、`AUTOMATION_CACHE_DIR`。
 */
import type { IntermediateDataRow, TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  prepareIntermediateStorage,
  XportBrowserClient,
} from 'xport-browser-sdk';

type ScrapedVideo = {
  videoUrl: string;
  caption: string;
  publishDate: string;
  likeCount: string;
};

const GRID_ITEM = '[id^="grid-item-container-"]';
const LIST_READY = '[data-e2e="search_top-item-list"]';

function socialHome(): string {
  const raw = (Bun.env.SOCIAL_HOME ?? 'https://www.tiktok.com').trim().replace(/\/+$/, '');
  return raw || 'https://www.tiktok.com';
}

function parseCollectCount(raw: string | number | undefined): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(Math.floor(n), 200);
}

function normalizeVideoUrl(href: string): string {
  try {
    const u = new URL(href, 'https://www.tiktok.com');
    if (!u.pathname.includes('/video/')) return '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

/** 从当前搜索结果 DOM 抽取视频卡片（仅 /video/，跳过图文等）。 */
const SCRAPE_JS = `(() => {
  const items = Array.from(document.querySelectorAll('${GRID_ITEM}'));
  const out = [];
  for (const el of items) {
    const a = el.querySelector('a[href*="/video/"]');
    if (!a) continue;
    const href = a.href || a.getAttribute('href') || '';
    if (!href.includes('/video/')) continue;
    const captionEl =
      el.querySelector('[data-e2e="search-card-video-caption"]') ||
      el.querySelector('[data-e2e="new-desc-span"]');
    const dateEl = el.querySelector('[class*="DivTimeTag"]');
    const likeEl = el.querySelector('[data-e2e="video-views"]');
    out.push({
      videoUrl: href,
      caption: (captionEl && captionEl.textContent ? captionEl.textContent : '').trim(),
      publishDate: (dateEl && dateEl.textContent ? dateEl.textContent : '').trim(),
      likeCount: (likeEl && likeEl.textContent ? likeEl.textContent : '').trim(),
    });
  }
  return JSON.stringify(out);
})()`;

async function scrapeVisibleVideos(client: XportBrowserClient): Promise<ScrapedVideo[]> {
  const [ok, msg, raw] = await client.evaluateInPage(0, SCRAPE_JS);
  if (!ok || raw == null) {
    client.taskLog(`scrape evaluate failed: ${msg}`);
    return [];
  }
  try {
    const parsed = JSON.parse(String(raw)) as ScrapedVideo[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        videoUrl: normalizeVideoUrl(String(row.videoUrl ?? '')),
        caption: String(row.caption ?? '').trim(),
        publishDate: String(row.publishDate ?? '').trim(),
        likeCount: String(row.likeCount ?? '').trim(),
      }))
      .filter((row) => row.videoUrl.length > 0);
  } catch (e) {
    client.taskLog(`scrape parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function scrollSearchFeed(client: XportBrowserClient): Promise<void> {
  const lastVisible = nodePath().css(GRID_ITEM).inViewport().last();
  const [countOk, , count] = await client.getNodeCount(0, lastVisible);
  if (!countOk || !count || count < 1) {
    client.taskLog('scroll: no in-viewport grid item');
    return;
  }
  await client.hoverNode(0, lastVisible);
  await Bun.sleep(600);
  await client.mouseWheel(0, lastVisible, { deltaY: 900 });
  await Bun.sleep(1200);
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const keyword = String(taskConfig.keyword ?? '').trim();
  const collectCount = parseCollectCount(taskConfig.collectCount);
  client.taskLog(`keyword=${keyword || '(empty)'} collectCount=${collectCount}`);

  if (!keyword) {
    return automationFailWithContext('keyword is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_keyword',
    });
  }

  const searchUrl = `${socialHome()}/search?q=${encodeURIComponent(keyword)}`;

  const [goOk, goMsg] = await client.pageGoTo(0, {
    url: searchUrl,
    timeoutMs: 60_000,
    wait: 'domcontentloaded',
  });
  if (!goOk) {
    const msg = goMsg || 'pageGoTo search failed';
    const [, , captured] = await client.captureIncident({
      step: 'open_search',
      reason: msg,
      code: 'NAV_FAILED',
      labels: { keyword, searchUrl },
    });
    return automationFailWithContext(msg, {
      code: 'NAV_FAILED',
      step: 'open_search',
      incidentId: captured?.incidentId,
      labels: { keyword, searchUrl },
    });
  }
  client.taskLog(`opened ${searchUrl}`);
  await Bun.sleep(800);

  const [waitOk, waitMsg] = await client.waitForSelector(0, {
    selector: LIST_READY,
    timeoutMs: 45_000,
    visible: true,
  });
  if (!waitOk) {
    const msg = waitMsg || 'search results list not found';
    const [, , captured] = await client.captureIncident({
      step: 'wait_search_list',
      reason: msg,
      code: 'ELEMENT_NOT_FOUND',
      labels: { keyword, searchUrl },
    });
    return automationFailWithContext(msg, {
      code: 'ELEMENT_NOT_FOUND',
      step: 'wait_search_list',
      incidentId: captured?.incidentId,
      labels: { keyword, searchUrl },
    });
  }
  await Bun.sleep(700);

  const seen = new Set<string>();
  const collected: IntermediateDataRow[] = [];
  let stagnantRounds = 0;
  const maxScrollRounds = Math.max(12, Math.ceil(collectCount / 4) + 8);

  for (let round = 0; round < maxScrollRounds && collected.length < collectCount; round++) {
    const batch = await scrapeVisibleVideos(client);
    let added = 0;
    for (const row of batch) {
      if (seen.has(row.videoUrl)) continue;
      seen.add(row.videoUrl);
      collected.push({
        videoUrl: row.videoUrl,
        caption: row.caption,
        publishDate: row.publishDate,
        likeCount: row.likeCount,
      });
      added += 1;
      if (collected.length >= collectCount) break;
    }
    client.taskLog(
      `round=${round} scraped=${batch.length} added=${added} total=${collected.length}/${collectCount}`,
    );

    if (collected.length >= collectCount) break;

    if (added === 0) {
      stagnantRounds += 1;
      if (stagnantRounds >= 3) {
        client.taskLog('no new videos after scrolls; stop');
        break;
      }
    } else {
      stagnantRounds = 0;
    }

    await scrollSearchFeed(client);
  }

  if (collected.length === 0) {
    const msg = 'no video cards collected from search results';
    const [, , captured] = await client.captureIncident({
      step: 'collect_videos',
      reason: msg,
      code: 'ELEMENT_NOT_FOUND',
      labels: { keyword, searchUrl },
    });
    return automationFailWithContext(msg, {
      code: 'ELEMENT_NOT_FOUND',
      step: 'collect_videos',
      incidentId: captured?.incidentId,
      labels: { keyword, searchUrl },
    });
  }

  const rows = collected.slice(0, collectCount);
  const [ingOk, ingMsg] = await client.ingestIntermediate(rows);
  if (!ingOk) {
    const msg = ingMsg || 'ingestIntermediate failed';
    const [, , captured] = await client.captureIncident({
      step: 'ingest_rows',
      reason: msg,
      code: 'UNKNOWN',
      labels: { keyword, count: String(rows.length) },
    });
    return automationFailWithContext(msg, {
      code: 'UNKNOWN',
      step: 'ingest_rows',
      incidentId: captured?.incidentId,
      labels: { keyword, count: String(rows.length) },
    });
  }

  const [, , finalUrl] = await client.getPageUrl();
  return {
    succ: true,
    msg: `collected ${rows.length} videos for "${keyword}"`,
    data: {
      keyword,
      collectedCount: rows.length,
      searchUrl: finalUrl || searchUrl,
    },
  };
}

const manifest = await loadAutomationManifest();
if (manifest.intermediateDataSchema) {
  const [prepOk, prepMsg] = await prepareIntermediateStorage(manifest);
  if (!prepOk) {
    console.error(`XPORT_TASK_RESULT:${JSON.stringify({ succ: false, msg: prepMsg || 'prepareIntermediateStorage failed' })}`);
    process.exit(1);
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
        step: 'unhandled',
        reason,
        code: 'UNKNOWN',
      });
      return automationFailWithContext(reason, {
        code: 'UNKNOWN',
        step: 'unhandled',
        incidentId: captured?.incidentId,
      });
    }
  }),
);
