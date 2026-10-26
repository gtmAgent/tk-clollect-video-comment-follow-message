import {
  defaultValuesFromFormGroups,
  loadAutomationManifest,
  runTaskValidate,
  validateTaskGroupScheduleConfig,
} from 'xport-content-sdk';

const code = await runTaskValidate();
if (code !== 0) process.exit(code);

try {
  const manifest = await loadAutomationManifest();
  const defaults = defaultValuesFromFormGroups(manifest.taskGroupConfig);
  const hasSchedule =
    'daily_limit' in defaults ||
    'during_min' in defaults ||
    'during_max' in defaults ||
    'daily_time_start' in defaults ||
    'daily_time_end' in defaults;
  if (hasSchedule) {
    const errors = validateTaskGroupScheduleConfig(defaults);
    if (errors.length > 0) {
      console.error(`task group schedule validation failed (${manifest.cmd}):`);
      for (const line of errors) console.error(`  - ${line}`);
      process.exit(1);
    }
    console.log('OK: task group schedule defaults');
  } else {
    console.log('OK: no task group schedule fields');
  }
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
