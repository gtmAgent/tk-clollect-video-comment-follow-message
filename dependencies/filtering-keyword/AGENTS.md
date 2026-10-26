# 内容创作任务 — 智能体开发指南

适用于 **`{SDK_PATH}/content_creation_template/`**（空白模版）或 **`{SDK_PATH}/{cmd}/`**（复制出的任务）。

`package.json` → **`xportAutomation`**，且 **`"target": "client"`**。参数与结果规范与浏览器/安卓/iOS 自动化任务**相同**（`CONFIG_SCHEMA` wire 一致）。

> 总流程 SSOT：`.cursor/skills/content-creation/SKILL.md` → `topics/dev-flow.md`。

---

## 0. 本模版是什么（重要）

`content_creation_template` 是**创作/工具项目的空白脚手架**：只保留 manifest / 入口 / 分发骨架与必要提示，**不含**混剪或其它成品业务。

复制到 `{cmd}/` 后，先与用户确认交付物，再改 schema 与代码。本机可跑的创作/工具均可，例如：

| 举例（非穷尽） | 常见能力 |
|----------------|----------|
| 视频混剪 / 剪辑 | `file`/`dir`、ffmpeg、`video` 结果 |
| 视频/音频下载转码 | yt-dlp + ffmpeg |
| 批量文案 / 数据处理 | 文本表单、写文件、可选云 API |
| 图像生成 / 图床整理 | 图片字段、本地或第三方 API；缩放转码用 `Bun.Image`（Skill `topics/bun-image.md`） |

**纪律**：占位字段 `note`、占位 `main.ts` **必须**在交付前整段替换；勿硬套脚手架字段。工具栈按需求选（本地 CLI / 开源库 / 合规云服务 / 纯脚本），**不固化**为某一种业务。

---

## 1. 阅读顺序

| 顺序 | 文档 | 路径 |
|------|------|------|
| 0 | 本 Skill `topics/dev-flow.md` | `agent_skills/content-creation/SKILL.md` |
| 0a | **静态图 `Bun.Image`** | Skill `topics/bun-image.md`（缩放/转码；勿先 ffmpeg） |
| 0b | **macOS/Windows 路径与 ffmpeg 滤镜** | Skill `topics/platform-compat.md`（涉字幕/滤镜/本机路径时必读） |
| 1 | SDK 约定、env、API | **`xport_content_sdk/AGENTS.md`** |
| 2 | manifest / wire | **`xport_content_sdk/CONFIG_SCHEMA.md`** |
| 3 | 中间数据 / 结果 UI | **`xport_content_sdk/AUTOMATION_DATA_AND_RESULT.md`** |
| 4 | 脚本内 AI | **`xport_content_sdk/SCRIPT_AI_PROMPT.md`** |

---

## 2. 本目录文件

| 文件 | 作用 |
|------|------|
| `package.json` → `xportAutomation` | schema（`target: client`）；占位字段待替换 |
| `config.types.ts` | 生成：`TaskRunConfig` / `TaskGroupConfig` / 结果类型 |
| `validate.ts` | 校验 schema + 生成类型（有频率字段时再校 schedule） |
| `main.ts` | 单次任务入口（占位：明确失败并提示改写） |
| `distribute.ts` | 任务组分发骨架（`deviceId: 0`，`target: client`） |

---

## 3. 新建项目后的第一步

1. 与用户确认：输入是什么、输出是什么、是否批量、是否要内置 CLI / 云 API。
2. 重写 `taskGroupConfig` / `taskRunConfig` / `taskResultConfig`（14 语 LocalizationText）。
3. 实现 `main.ts`；需要时再拆辅助模块（**不要**从旧混剪示例抄无关字段）。
4. 按批量规则改 `distribute.ts`；`tasks[].config` 键与 `taskRunConfig` 一致。
5. 更新根级 `description`（14 语）；bump `version` 时同步 **`{SDK_PATH}/{cmd}_tar.txt`**。
6. 临时/自测文件只用 `AUTOMATION_CACHE_DIR`（`{SDK_PATH}/cache/{cmd}/`；勿写 cwd 或用户 `outputDir`）。

占位入口会 `succ: false` 并在 `summary` 里写清「尚未实现」——这是预期行为，直到业务写完。

---

## 4. 阶段 A / B

1. **阶段 A**：与用户确认 `taskRunConfig` → 实现 `main.ts` → **`content_project_verify`**。
2. **阶段 B**（批量）：`taskGroupConfig` + `distribute.ts`；需要多主题/频率排程时再加字段并改 `distribute.ts`。
3. 有 schema/行为变更时 bump `package.json` `version`，并同步 **`{SDK_PATH}/{cmd}_tar.txt`**（单行，与 `version` 相同）。

---

## 5. 完成检查

- [ ] `{BUN} --no-env-file validate.ts` 退出码 0
- [ ] MCP **`content_project_verify`** 返回 `ok: true`
- [ ] `return { succ, msg, data }` 键与 `taskResultConfig` 对齐
- [ ] **占位 `note` / 占位失败逻辑已移除**，业务可真实跑通
- [ ] **`{SDK_PATH}/{cmd}_tar.txt` 已与 `package.json` version 同步**（bump 版本时必做）
- [ ] 第三方密钥仅通过 `Bun.env` / 环境变量模块
- [ ] 临时文件仅 `AUTOMATION_CACHE_DIR`（试跑/中间文件勿写 cwd 或用户 outputDir）
- [ ] 静态图缩放/转码用 **`Bun.Image`**（Skill `topics/bun-image.md`）；**不要**为此 ensure ffmpeg
- [ ] 用到 ffmpeg / yt-dlp / sproxy 等内置 CLI 时，`main.ts` 内先 **`ensureBuiltinTools`**（见 `xport_content_sdk/AGENTS.md` §内置 CLI）
- [ ] 表单有出口/中转代理时，`main.ts` 用 **`client.startLocalSproxy`**，禁止设备 `applyProxy` / `APPLY_PROXY` / `POST /browser/cmd`
- [ ] 涉滤镜嵌路径 / 烧录字幕时已按 Skill **`topics/platform-compat.md`** 处理 Windows 盘符（单引号 + `\:`）
- [ ] `distribute.ts` 下发的 `config` 键与 `taskRunConfig` 一致（勿漏可选字段）

---

## 6. 端到端闭环（智能体会话 → 任务跑通）

```
初始化新建 {cmd} → 会话 cwd = {SDK_PATH}/{cmd}
  → 先确认用户要做什么（混剪 / 下载 / 数据处理 / 图像生成 / …）
  → 按需求重写 manifest / main.ts / distribute.ts（丢弃占位字段）
  → content_project_verify（自动 bun install + validate + 试跑）
  → 用户建任务组 → distribute.ts 生成子任务
  → 任务执行 main.ts（本机，无设备）
```

失败时：读任务日志 → 改码 → 再次 **`content_project_verify`**。无设备排错 / `captureIncident`。
