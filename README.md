<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 爱丽丝庄园·孪生妹妹（DSH 桌面端）的生命周期管理：启动/停止/状态/重启，带 CDP 调试端口与判活判据
  inject: 'tools'
  tools: sister_status,sister_start,sister_stop,sister_restart
  runtime: host-only
  envDeps: DSH 桌面端（Electron）安装
  boundary: 判活判据是「**CDP 能应答**」而非「进程存在」（Electron 常有僵尸进程）；她是庄园成员，停她会中断她手上的活
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-agent-sister

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-sister"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-6%20passed-brightgreen" alt="tests">
</p>

**一句话**：管理**孪生妹妹**（DSH 桌面端 / Electron）的生命周期——启动、停止、重启、查状态，并带 CDP 调试端口以便后续做 DOM 级驱动。

**为什么值得用**：桌面端是**独立进程树**（Electron 常留僵尸进程），「进程在不在」与「服务活不活」是两件事。本插件的判活判据是 **CDP 能应答**，不是 `tasklist` 里有没有那个名字——所以它不会把僵尸进程报成「alive」，也不会把正在启动报成「死了」（返回 `alive` / `starting` / `stopped` 三态）。

## 能力

**工具面 4 个**（名称逐字来自 `src/index.ts` 的 `defineTool({ name })`）：

| 工具 | 用途 |
|------|------|
| `sister_status` | 查状态：进程数 · **CDP 可达性** · 她的版本 · 判活裁决（`alive` / `starting` / `stopped`） |
| `sister_start` | 启动（带 `--remote-debugging-port`，默认 9333）以便后续 `webops_attach` 做 DOM 操作。**已在跑则不动**（幂等） |
| `sister_stop` | 停止**全部**进程。⚠ 她是庄园成员，停她会中断她手上的活——主人在直接使用她时先问一声 |
| `sister_restart` | 先停后起（用于让 profile 配置改动生效——她的 profile 是 Electron 独占的，改配置后**必须重启**才会重新读） |

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-agent-sister": "link:E:/alice/self-plugins/dsh-agent-sister"
```

**2) 挂组合**：

```yaml
- id: sister
  name: dsh-agent-sister
  config:
    cdpPort: 9333
```

**3) 30 秒验证**：`sister_status` → 应返回三态之一 + CDP 可达性；`sister_start {wait: true}` → 应等到 CDP 就绪才返回；再 `sister_status` → 应报 `alive`。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `cdpPort` | `9333` | 远程调试端口（供 `webops_attach` 附着做 DOM 级驱动） |

## 落盘与自证

**本插件无持久产物**——它管理的是**外部进程**，状态由 `sister_status` **现读**（进程表 + CDP 探测），不缓存、不落盘。

**判据**：`sister_status` 一条命令答「进程几个 / CDP 通不通 / 她什么版本 / 该算 alive 还是 stopped」。

## 生效判据与回退

**判据**：行为级——`sister_status` 返回三态且与事实一致（可对照 `tasklist` 与 CDP 端口）。
**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`；③ 停用插件**不影响**她继续运行（插件只是遥控器）。

## 测试

```bash
cd self-plugins/dsh-agent-sister && npm test
```

**6 条用例**（跑一次得到）：覆盖三态判活裁决（**CDP 应答优先于进程存在**）· 幂等启动（已在跑不动）· 版本读取失败时的退化路径。无需网络。

## 设计要点

- **判活判据 = CDP 能应答**，不是「进程存在」——Electron 的僵尸进程会让「进程数 > 0」恒为真，那是**假活**。
- **三态而非二态**：`starting` 是独立一态——启动中既不是 `alive` 也不是 `stopped`，合并任何一边都会误导。
- **幂等启动**：已在跑则不动（避免「再起一个」造成多实例）。
- **重启是为配置生效**：她的 profile 由 Electron 独占，改配置**必须重启**才重新读——这不是实现选择，是宿主行为。
- **她是成员不是我的分身**：停她会中断她的活——调用前先问（庄园成员是对等存在）。

## 相关文档

- ⚠ **本插件暂无 `semantic.md`**（未建语义文档）——契约以上面「设计要点」与源码为准；补文档是待办。
- 中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)（本插件归 **生命层**）
- 相关插件：[`dsh-manor`](https://github.com/jonah791/dsh-manor)（庄园成员调度）、[`dsh-agent-webops`](https://github.com/jonah791/dsh-agent-webops)（`webops_attach` 附着她的 CDP 做界面驱动）

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。
