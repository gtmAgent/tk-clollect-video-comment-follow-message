/**
 * 任务组分发入口：将组配置按本任务规则拆成多条待运行任务。
 *
 * 分配规则（`even_distribute` 开关）：
 * - `1`（开）：链接轮询均分到各浏览器（每条链接只分配一次）
 * - `0`（关，默认）：每台浏览器跑全部链接（笛卡尔积）
 *
 * 阶段 B 定稿后试跑：`{BUN} --no-env-file distribute.ts`（桌面注入 wire）；
 * 核对 stdout `data.tasks` 条数与各条 `config` 键名与 `taskRunConfig` 一致。见 AGENTS.md §3.2、Skill `topics/manifest-phase.md`。
 */
import type { TaskGroupConfig } from './config.types';
import {
  type AutomationRunResult,
  type AutomationTaskManifest,
  localDayEndSec,
  localDayStartSec,
  parseBrowserDeviceIds,
  parsePositiveIntConfig,
  parseTimeToMinutes,
  randomIntBetween,
  splitConfigLines,
  type TaskCreateInput,
  validateTaskGroupScheduleConfig,
  XportBrowserAdminClient,
} from 'xport-browser-sdk';

type PerBrowserScheduleState = {
  dayOffset: number;
  usedInDay: number;
  cursorSec: number;
};

type HostBrowserPair = { host: string; browserId: number };

function rollBrowserToNextDay(baseSec: number, st: PerBrowserScheduleState, dayStartMin: number): void {
  st.dayOffset += 1;
  st.usedInDay = 0;
  st.cursorSec = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
}

/** 为「当前这条」任务准备可排期时刻：超结束时间、开始+间隔超结束、或超单日上限则滚到下一天。 */
function prepareSlotForCurrentTask(
  baseSec: number,
  st: PerBrowserScheduleState,
  dailyLimit: number,
  duringMin: number,
  dayStartMin: number,
  dayEndMin: number,
): void {
  const maxDayRolls = 366;
  let dayRolls = 0;
  for (;;) {
    const dayStart = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
    const dayEnd = localDayEndSec(baseSec, st.dayOffset, dayEndMin);
    if (st.cursorSec < dayStart) st.cursorSec = dayStart;
    const exceedsDayEnd = st.cursorSec > dayEnd || st.cursorSec + duringMin > dayEnd;
    if (st.usedInDay >= dailyLimit || exceedsDayEnd) {
      if (++dayRolls > maxDayRolls) {
        throw new Error('schedule: too many day rollovers (check daily_limit / during_min / time window)');
      }
      rollBrowserToNextDay(baseSec, st, dayStartMin);
      continue;
    }
    return;
  }
}

/** 构建 (host, browser) 配对：even=轮询均分；否则笛卡尔积。 */
function buildHostBrowserPairs(
  hosts: string[],
  browserIds: number[],
  evenDistribute: boolean,
): HostBrowserPair[] {
  const pairs: HostBrowserPair[] = [];
  if (evenDistribute) {
    for (let i = 0; i < hosts.length; i++) {
      pairs.push({ host: hosts[i]!, browserId: browserIds[i % browserIds.length]! });
    }
  } else {
    for (const browserId of browserIds) {
      for (const host of hosts) {
        pairs.push({ host, browserId });
      }
    }
  }
  return pairs;
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const hosts = splitConfigLines(groupConfig.hosts);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);
  const evenDistribute = Number(groupConfig.even_distribute) !== 0;

  if (hosts.length === 0) {
    return { succ: false, msg: 'no hosts in group config' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: 'no browsers selected' };
  }

  const dailyLimit = parsePositiveIntConfig(groupConfig.daily_limit, 10);
  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 60);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 600);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');
  const scheduleErrors = validateTaskGroupScheduleConfig(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];
  const pairs = buildHostBrowserPairs(hosts, browserIds, evenDistribute);

  for (const { host, browserId } of pairs) {
    const st: PerBrowserScheduleState =
      perBrowserSchedule.get(browserId) ??
      ({
        dayOffset: 0,
        usedInDay: 0,
        cursorSec: Math.max(nowSec, localDayStartSec(nowSec, 0, dayStartMin)),
      } satisfies PerBrowserScheduleState);

    prepareSlotForCurrentTask(nowSec, st, dailyLimit, duringMin, dayStartMin, dayEndMin);

    const planStartAt = st.cursorSec;
    tasks.push({
      gid,
      cmd: manifest.cmd,
      deviceId: browserId,
      target: manifest.target,
      config: { host },
      planStartAt,
    });

    st.usedInDay += 1;
    st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);
    perBrowserSchedule.set(browserId, st);
  }

  if (tasks.length === 0) {
    return { succ: false, msg: 'no tasks generated (check daily_limit / hosts / browsers)' };
  }

  const mode = evenDistribute ? 'even' : 'all';
  return {
    succ: true,
    msg: `generated ${tasks.length} tasks (mode=${mode})`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
