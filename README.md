# dsh-live-diff

> Copilot 风格的行内 diff：DSH 里每一次改文件都当场显示 `+A −R` 和差异内容，轮末给一条 `N files changed +X −Y` 汇总条，带 **Keep** 与 **Undo**。

一个 DeepSeek Harness 的 web 插件。它不拦截、不代理任何模型调用——只是观察已经成功的 `edit` / `write` / `apply_patch` 结果，把「这一次调用改了什么」独立记成一条，然后在聊天流里就地渲染。

```
● Edited slot_rotator.h                        +54  −55   [Undo]
  ┌──────────────────────────────────────────────────────────┐
  │  41   41    double dt = now - last_;                     │
  │  42   42    if (dt < min_gap_) return;                   │
  │  43        - rate_ = ticks_ / dt;                        │
  │       43   + rate_ = ticks_ * 1e6 / max(dt, kFloorUs);    │
  └──────────────────────────────────────────────────────────┘

  ◧ 3 files changed · 5 edits        +716  −302   [Review] [Keep] [Undo all]
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 每次修改自动追踪 | 观察 `edit` / `write` / `apply_patch`，一次调用 = 一条独立记录（`apply_patch` 改多个文件时按文件各记一条） |
| 行内 diff | 每条记录在聊天流里就地显示统一 diff：双侧行号、`@@` 块头、增删底色；超过 12 行折叠为「Show N more lines」 |
| 增删统计 | 动作行右侧常驻 `+A −R`，与 Copilot 的动作行一致 |
| 轮末汇总条 | `N files changed · M edits  +X −Y`，带 **Review / Keep / Undo all** |
| 单次撤销 | 每条记录自己的 Undo：只把这一次编辑替换掉的文本写回，不影响同文件的其他编辑 |
| 冲突保护 | 只有当磁盘内容仍等于该次编辑的 `after` 时才写回；否则拒绝，并提示先撤销更新的那次——绝不吞掉后来的改动 |
| 会话累计 | 记录按 session 持久化，重开页面/重连后仍在；Review 面板列出整轮的全部编辑 |
| 零依赖、零构建 | 服务端是纯 ESM，客户端是手写 module-loader bundle，`npm test` 用 `node --test` |

### 与现有三个插件的关系

同类插件各自只覆盖一部分（下表来自这三个插件的官方对比）：

| 能力 | change-review | diff-approval | file-changes | **dsh-live-diff** |
| --- | --- | --- | --- | --- |
| 每次修改自动追踪 | 支持 | 支持 | 支持 | **支持** |
| 独立修改记录 | 支持 | 按文件聚合 | 按文件聚合 | **支持（按调用，一次可多文件）** |
| 实时变更面板 | 支持 | 支持 | 轮末展示 | **支持（轮末汇总条 + Review 面板）** |
| 每轮 Diff 汇总 | 支持 | 否 | 支持 | **支持（含 +/− 统计）** |
| 单次修改撤销 | 支持 | 按块撤销 | 否 | **支持（按记录，带冲突保护）** |
| 会话累计审查 | 支持 | 支持 | 否 | **支持** |
| npm 发布 | 否 | 是 | 未确认 | 见下 |

可以单独用，也可以和 `diff-approval` 同时装：后者管「改之前/之后」的审批，本插件管「改完了，摊开给你看、能一条条撤回」。两者都占 `tool.call.toolview` 的同一个 key 时，后注册的那一个生效；若只想保留其中一个，卸载另一个即可。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-live-diff

# 直接从 GitHub 装（pnpm 支持 git 依赖）
dsh plugin --profile web add github:huieric/dsh-live-diff

# 或先 clone，再从本地目录装
git clone https://github.com/huieric/dsh-live-diff.git
dsh plugin --profile web add ./dsh-live-diff

# 然后重启 web
dsh web
```

插件自带 `cordis.patch.yml`（`dsh.bundle.patch`），装进 profile 后会自动插入自身的插件行，无需手改配置。

### 装不上时

两个真实踩过的坑：

1. **`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK … /run/user/<uid>/pnpm-store-operation-locks-*/all-stores.lock: Permission denied`**
   pnpm 把 store 的操作锁放在 `$XDG_RUNTIME_DIR` 下；该目录不可写（容器、systemd 用户会话异常、或命令跑在受限沙箱里）时安装会直接失败。把锁指到可写目录即可：

   ```bash
   XDG_RUNTIME_DIR="$HOME/.run" dsh plugin --profile web add dsh-live-diff
   ```

2. **装完不生效 / 启动摘要里 `live-diff (dsh-live-diff): …` 之后整条消失**
   看 `dsh` 启动摘要里的 "did not activate" 一行，它写明了原因。`0.1.0` 曾漏声明 `webServer` 服务（`cannot get property "webServer" without inject`），`0.1.1` 已修复——升级即可。

完全不依赖 pnpm 的安装方式（离线可用：复制文件 + 注册 bundle）：

```bash
./scripts/install-local.sh          # 装进 web profile
./scripts/install-local.sh --remove # 卸载
```

## 使用

- **看**：每条改文件的动作行右侧就是 `+A −R`，下方是这一次的 diff。点文件名在编辑器打开该文件，点「Show N more lines」展开完整补丁。
- **撤销一条**：动作行右侧的 `Undo`。它把这次编辑替换掉的原文写回；如果这之后磁盘又被改过（无论谁改的），它会拒绝并说明原因。
- **保留**：轮末汇总条的 `Keep` 把整轮标记为已看过（不写文件，只是把记录标记为 `kept`，从待审查里移出）。`Keep` 旁边是 `Undo all`，按逆序回滚整轮，跳过有冲突的记录，并在需要时报告哪些没撤成。
- **Review**：展开轮末面板，逐条看每一轮的编辑、单独撤销其中某一条。

## 通道与存储

服务端注册连接通道 `/live-diff`（`authority: trusted-host`），客户端只在**本地**通过它读数据：

| endpoint | 载荷 | 返回 |
| --- | --- | --- |
| `list` | `{ sessionId }` | `{ revision, totals, records[] }`（不含 diff 正文） |
| `detail` | `{ sessionId, callId }` | `{ records[] }`（含 hunks） |
| `keep` | `{ sessionId, id? }` | `{ changed, ...summary }` |
| `keep-all` | `{ sessionId }` | `{ changed, ...summary }` |
| `revert` | `{ sessionId, id }` | summary，或 `error.code = "conflict"` |
| `revert-all` | `{ sessionId }` | `{ reverted, failures[], ...summary }` |
| `clear` | `{ sessionId }` | summary |

记录落盘在 `${DSH_HOME:-~/.dsh}/live-diff/sessions/<session>.json`，每 session 最多保留 400 条（超出丢最旧的）。**文件正文会写进这个文件**（撤销要靠它），只是本地数据，不会发到网络。

## 实现要点

- `ctx.on("tools/result", (exec, result) => …)` 里只取 `result.isError === false` 且命中三个文件写入工具的调用；`before === after` 的空改动不入库。
- diff 是手写的：先剥掉公共前后缀，再按「两侧唯一出现的同一行」递归切分，小区域用 LCS（DP 上限 100 万格），都不满足就退化成整段替换——所以超大补丁不会卡住，也不会退化成一屏红色。
- 撤销不做「按块」或「按行」的猜测：整条记录只有 before/after 两个版本，写回前先读盘比对，不一致就拒绝。宁可少撤，不可误撤。

## 已知限制

- 只覆盖 `edit` / `write` / `apply_patch`。`str_replace_editor` 与 shell 里的 `sed` 之类不追踪（没有可信的 before/after）。
- 撤销是「整条记录」粒度的；一次 `apply_patch` 里同一文件的多次改动会合成一条记录。
- 记录随 session 走；跨 session 的同一文件改动不会合并计数。
- npm 包名 `dsh-live-diff` 已在仓库里就绪，发布状态见仓库 Release。

## 变更记录

- `0.1.1` — 修复无法激活：`inject` 漏了 `connection.register` 内部实际依赖的 `webServer`（启动摘要显示 `cannot get property "webServer" without inject`）。测试补了一条守卫，要求声明的服务覆盖真正用到的服务，这类问题从此是测试失败而不是装完静默消失。
- `0.1.0` — 首个版本。

## 开发

```bash
git clone https://github.com/huieric/dsh-live-diff.git
cd dsh-live-diff
npm test          # 22 个用例：diff 引擎 / 服务端记录与撤销 / 客户端渲染与注册
```

- `lib/index.js` — 服务端：diff 引擎、每 session 的 `EditLog`、`/live-diff` 通道。
- `lib/client.js` — 客户端：`tool.call.toolview`（`edit`/`write`/`apply_patch` 三个 key）+ `conversation.chat.turnTail` 两条视图，手写 bundle，无构建步骤。
- `test/` — `node --test`。

## License

MIT © huieric
