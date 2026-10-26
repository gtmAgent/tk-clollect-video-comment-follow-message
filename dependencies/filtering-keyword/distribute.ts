/**
 * 任务组分发：一套筛选参数 → 一条 client 子任务。
 */
import type { TaskGroupConfig, TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  type TaskCreateInput,
  XportContentAdminClient,
} from 'xport-content-sdk';

function pickRunConfig(group: TaskGroupConfig): TaskRunConfig {
  return {
    sourceFile: group.sourceFile ?? '',
    keywords: group.keywords ?? '',
    publishStart: group.publishStart,
    publishEnd: group.publishEnd,
    likeMin: group.likeMin,
    likeMax: group.likeMax,
    outputDir: group.outputDir ?? '',
  };
}

async function distributeGroup(ctx: {
  manifest: Awaited<ReturnType<typeof import('xport-content-sdk').loadAutomationManifest>>;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const config = pickRunConfig(groupConfig);
  const nowSec = Math.floor(Date.now() / 1000);
  const tasks: TaskCreateInput[] = [
    {
      gid,
      cmd: manifest.cmd,
      deviceId: 0,
      target: 'client',
      config,
      planStartAt: nowSec,
    },
  ];

  return {
    succ: true,
    msg: 'generated 1 filter task',
    data: { tasks },
  };
}

process.exit(await XportContentAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
