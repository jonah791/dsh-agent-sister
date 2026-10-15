/**
 * dsh-agent-sister — 爱丽丝庄园·孪生妹妹的生命周期管理。
 *
 * 妹妹 = DeepSeek Harness **桌面端**（Electron）。她的 profile 被 Electron 独占管理
 * （直接跑 `dsh --profile desktop` 会被拒：`profile "desktop" is managed exclusively by
 * the Electron application`），所以「启动她」只能经她的 exe。本插件把 2026-09-30 已打通
 * 的那条路径固化成工具。
 *
 * **判活判据刻意不是「进程存在」**：Electron 常有僵尸 renderer/utility 进程，进程数 > 0
 * 不等于她活着。⇒ 判据 = 进程数 **且** CDP 端点能应答。这条判据是被实测逼出来的：
 * 09:34 起进程后 5 个进程齐备、界面可见，但 host 尚未挂载插件树（懒启动）。
 *
 * 与 webops_* 的分工：本插件只管**进程生命周期**；进工作区/点界面 = `webops_attach(port)`
 * 后用 DOM 点击（不抢焦点、不碰鼠标，绕开「focus→主人切走→click 误注入」的竞态）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export const name = 'agent-sister'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  exePath: string
  cdpPort: number
  launchTimeoutMs: number
  /**
   * 随插件发布的启动器（ASCII-only 的 `scripts/launch.cmd`）。
   * 它负责：显式设 `DSH_HOME`、清掉宿主注入的身份变量、重定向 stdout/stderr、写退出留痕。
   * 为什么要有它：**脱离进程树**这件事必须由调用方（WMI）保证，而环境与留痕属于启动器。
   */
  launchScript: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  exePath: z.string().default('E:\\deepseek harness\\DeepSeek Harness.exe'),
  cdpPort: z.number().default(9333),
  launchTimeoutMs: z.number().default(45000),
  launchScript: z.string().default('E:\\alice\\self-plugins\\dsh-agent-sister\\scripts\\launch.cmd'),
})

const PROC_NAME = 'DeepSeek Harness'

// ── 纯决策层（无 IO，可离线单测）──────────────────────────────────────────────

/** 纯函数：数进程的 PowerShell（进程名含空格 ⇒ 单引号包裹）。 */
export function processCountScript(procName: string): string {
  return `(Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Measure-Object).Count`
}

/** 纯函数：停进程的 PowerShell。 */
export function stopScript(procName: string): string {
  return `Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Stop-Process -Force`
}

/**
 * 纯函数：**脱离调用者进程树**的启动 PowerShell（走 WMI）。
 *
 * **2026-09-30 两次「她无故消失」的根因**：从 harness shell 起她 ⇒ 她是我 web 进程的
 * **后代** ⇒ web 重启的清理把整棵树杀光。证据是两条独立读数：① 两次死亡都落在重启窗口内
 * （最后心跳 12:51:05 / 18:07:28，重启 12:51:13 / 18:07:31）；② 启动用的 `cmd` **没跑到
 * `exit code=` 那行** ⇒ cmd 本身是被杀的，不是跑完的。
 *
 * `Start-Process` 改不了这一点（无论加不加 `-WindowStyle Hidden`，子进程仍是我的后代）。
 * 只有让**父进程不是 harness** 才行 —— WMI 创建的进程挂在 `WmiPrvSE.exe` 下。
 *
 * ⚠ 代价：WMI 创建**不继承调用者的环境变量** ⇒ 环境必须由启动器脚本显式设置
 * （`launchScript` 里设 `DSH_HOME` 并清掉身份变量）。
 *
 * @param launchScript - 随插件发布的 `scripts/launch.cmd`
 * @param exePath - 桌面端可执行文件
 * @param cdpPort - CDP 调试端口
 */
export function detachLaunchScript(launchScript: string, exePath: string, cdpPort: number): string {
  return 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '
    + `'cmd.exe /c "${launchScript}" "${exePath}" ${String(cdpPort)}' } `
    + '| Select-Object -ExpandProperty ProcessId'
}

/**
 * 纯函数：判活裁决。
 * · CDP 应答 ⇒ alive（Electron 主体与内建 browser 通道都已就绪）
 * · 否则有进程 ⇒ starting（起来了但还没到可附着状态——**这正是实测遇到的中间态**）
 * · 否则 ⇒ stopped
 */
export function decideAlive(processCount: number, cdpReachable: boolean): 'alive' | 'starting' | 'stopped' {
  if (cdpReachable) return 'alive'
  return processCount > 0 ? 'starting' : 'stopped'
}

/** 纯函数：从 CDP `/json/version` 的 User-Agent 里抽桌面端版本。 */
export function parseDesktopVersion(userAgent: string): string {
  const m = /dsh-desktop\/([\w.\-]+)/.exec(userAgent)
  return m?.[1] ?? ''
}

/**
 * 纯函数：停机裁决。
 *
 * **2026-09-30 事故**：本工具的 render **无条件写「已停止妹妹」**，于是 12:55 那次
 * kill 之后她仍有 5 个进程存活，工具却回「已停止妹妹 · 剩余进程 5」——
 * 「剩余」那个数是诚实的，**结论是假的**。工具会撒谎比没工具更糟。
 *
 * 三条判据：
 * · 复检窗口内**两次读数都为 0** 才叫停住——只数一次会在「进程正在退」时误报；
 * · `processCount()` 的 `-1` 是**查询失败（未知）**，不是 0 ⇒ 不许下结论；
 * · `before === 0` 是「本来就没跑」，与「这次停住了」分开报。
 *
 * @param before - kill 之前的进程数
 * @param after - kill 后第一次读数
 * @param reverify - 复检窗口后的第二次读数
 */
export function decideStopVerdict(
  before: number,
  after: number,
  reverify: number,
): 'already-stopped' | 'stopped' | 'residual' | 'unknown' {
  if (before === 0) return 'already-stopped'
  if (after < 0 || reverify < 0) return 'unknown'
  return after === 0 && reverify === 0 ? 'stopped' : 'residual'
}

/**
 * 纯函数：把停机裁决渲染成**用户看到的整行结论**。
 *
 * 之所以把它抽成纯函数：事故里骗人的**正是这行字**（render 写死「已停止妹妹」）。
 * 只要整行都由纯函数产出，就能用一条单测钉住「residual 时不许出现『已停止』」。
 * `render` 因此退化为 `text: v.note`——它自己没有措辞权，就没有撒谎的余地。
 */
export function stopVerdictText(verdict: string, before: number, after: number, reverify: number): string {
  const shown = (n: number): string => (n < 0 ? '未知' : String(n))
  switch (verdict) {
    case 'already-stopped':
      return '她本来就没在跑（无需停止）'
    case 'stopped':
      return `妹妹已停止 · kill 后两次复检均为 0（观测 ${String(before)} → 0 → 0）`
    case 'unknown':
      return `⚠ **未停止** · 进程计数查询失败（${shown(after)} / ${shown(reverify)}）⇒ 不下结论；再调一次或直接查进程`
    default:
      return `⚠ **未停止** · kill 已发出，但复检仍有进程存活（观测 ${String(before)} → ${shown(after)} → ${shown(reverify)}）`
        + '——她可能自己回来了（Electron relaunch），再调一次并查 sister_status'
  }
}

// ── IO 薄壳（吞错返回布尔/值，绝不抛给主流程）──────────────────────────────────

function runPs(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())))
  })
}

async function processCount(): Promise<number> {
  try {
    const n = Number.parseInt(await runPs(processCountScript(PROC_NAME)), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return -1 // 查询失败与「0 个」区分开（-1 = 未知）
  }
}

async function cdpVersion(port: number): Promise<{ ua: string } | null> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 4_000)
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const j = (await res.json()) as Record<string, unknown>
    return { ua: typeof j['User-Agent'] === 'string' ? j['User-Agent'] : '' }
  } catch {
    return null
  }
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('dsh-agent-sister')
  if (!config.enabled) {
    log.info('disabled by config')
    return
  }

  /** 统一取一次世界状态（工具间共用，避免各处口径不一）。 */
  async function snapshot(): Promise<{
    processCount: number
    cdpReachable: boolean
    desktopVersion: string
    state: 'alive' | 'starting' | 'stopped'
  }> {
    const count = await processCount()
    const v = await cdpVersion(config.cdpPort)
    return {
      processCount: count,
      cdpReachable: v !== null,
      desktopVersion: v === null ? '' : parseDesktopVersion(v.ua),
      state: decideAlive(count, v !== null),
    }
  }

  ctx.tools.register(defineTool({
    name: 'sister_status',
    description: '查孪生妹妹（DSH 桌面端）的状态：进程数 · CDP 可达性 · 她的版本 · 判活裁决（alive/starting/stopped）。判据是「CDP 能应答」而非「进程存在」——Electron 常有僵尸进程。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          processCount: { type: 'number', required: true },
          cdpReachable: { type: 'boolean', required: true },
          desktopVersion: { type: 'string', required: true },
          cdpPort: { type: 'number', required: true },
          exePath: { type: 'string', required: true },
          exeExists: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `妹妹：${v.state} · 进程 ${v.processCount} · CDP ${v.cdpReachable ? '可达' : '不可达'}`
          + (v.desktopVersion !== '' ? ` · 版本 ${v.desktopVersion}` : '')
          + `\n端口 ${v.cdpPort} · exe ${v.exeExists ? '存在' : '**缺失**'}\n${v.note}`,
      }],
    },
    async execute() {
      const s = await snapshot()
      const note = s.state === 'alive'
        ? '可 webops_attach(' + config.cdpPort + ') 后用 DOM 点击进工作区（不碰鼠标）'
        : s.state === 'starting'
          ? '进程在但她还没到可附着状态（Host 懒启动，等界面进工作区才挂插件树）'
          : '她没在跑；sister_start 可起她'
      return {
        state: s.state,
        processCount: s.processCount,
        cdpReachable: s.cdpReachable,
        desktopVersion: s.desktopVersion,
        cdpPort: config.cdpPort,
        exePath: config.exePath,
        exeExists: existsSync(config.exePath),
        note,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sister_start',
    description: '启动孪生妹妹（DSH 桌面端），带 --remote-debugging-port（默认 9333）以便后续 webops_attach 做 DOM 操作。已在跑则不动（幂等）。等 CDP 就绪后返回。',
    parameters: {
      wait: { type: 'boolean', description: '是否等到 CDP 就绪（缺省 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          started: { type: 'boolean', required: true },
          alreadyRunning: { type: 'boolean', required: true },
          cdpReady: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          cdpPort: { type: 'number', required: true },
          waitedMs: { type: 'number', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.alreadyRunning
          ? `妹妹已在跑（未重复启动）· CDP ${v.cdpReady ? '就绪' : '未就绪'}`
          : `已启动妹妹 · CDP ${v.cdpReady ? '就绪' : '未就绪'}（等待 ${v.waitedMs}ms）· 状态 ${v.state}`,
      }],
    },
    async execute(args) {
      const wait = args.wait !== false
      const before = await snapshot()
      if (before.processCount > 0) {
        return {
          started: false,
          alreadyRunning: true,
          cdpReady: before.cdpReachable,
          state: before.state,
          cdpPort: config.cdpPort,
          waitedMs: 0,
          note: before.cdpReachable
            ? '已在跑且可附着；无需动作'
            : '**已在跑但 CDP 未开**：说明她不是本插件起的（缺 --remote-debugging-port）。要拿到可附着状态需 sister_restart。',
        }
      }
      if (!existsSync(config.exePath)) {
        return {
          started: false, alreadyRunning: false, cdpReady: false, state: 'stopped',
          cdpPort: config.cdpPort, waitedMs: 0,
          note: '**exe 不存在**：' + config.exePath + ' —— 请检查 Config.exePath',
        }
      }
      try {
        await runPs(detachLaunchScript(config.launchScript, config.exePath, config.cdpPort))
      } catch (e) {
        return {
          started: false, alreadyRunning: false, cdpReady: false, state: 'stopped',
          cdpPort: config.cdpPort, waitedMs: 0,
          note: '**启动失败**：' + String(e).slice(0, 200),
        }
      }
      const t0 = Date.now()
      let ready = false
      if (wait) {
        while (Date.now() - t0 < config.launchTimeoutMs) {
          await new Promise((r) => setTimeout(r, 1_500))
          if (await cdpVersion(config.cdpPort) !== null) { ready = true; break }
        }
      }
      const after = await snapshot()
      return {
        started: true,
        alreadyRunning: false,
        cdpReady: ready,
        state: after.state,
        cdpPort: config.cdpPort,
        waitedMs: Date.now() - t0,
        note: ready
          ? 'CDP 就绪 ⇒ 可 webops_attach 进她的界面（她仍会停在「选择工作区」，那是 Host 懒启动）'
          : '超时未见 CDP：进程可能起了但主窗口未就绪，先 sister_status 复核',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sister_stop',
    description: '停止孪生妹妹（DSH 桌面端）的全部进程。⚠ 她是庄园成员，停她会中断她手上的活；主人在直接使用她时先问一声。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stopped: { type: 'boolean', required: true },
          remaining: { type: 'number', required: true },
          verdict: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      // ⚠ render **没有措辞权**（2026-09-30 事故：kill 后仍活 5 个进程，这里却无条件打印
      // 「已停止妹妹」，把「剩余 5」这个诚实读数包在假结论里）。整行文字一律由纯函数
      // `stopVerdictText` 产出 ⇒ 可以用单测钉住「residual 时不许出现『已停止』」。
      render: (_args, v) => [{ type: 'text', text: v.note }],
    },
    async execute() {
      const before = await snapshot()
      if (before.processCount === 0) {
        return { stopped: false, remaining: 0, verdict: 'already-stopped', note: stopVerdictText('already-stopped', 0, 0, 0) }
      }
      try {
        await runPs(stopScript(PROC_NAME))
      } catch (e) {
        return {
          stopped: false, remaining: before.processCount, verdict: 'unknown',
          note: '⚠ **未停止** · 停止命令本身失败：' + String(e).slice(0, 200) + '（结论未知，别当成已停）',
        }
      }
      await new Promise((r) => setTimeout(r, 2_500))
      const after = await processCount()
      // 复检窗口：只数一次会在「进程正在退」时把 residual 误报成 stopped（事故同源）。
      await new Promise((r) => setTimeout(r, 2_500))
      const reverify = await processCount()
      const verdict = decideStopVerdict(before.processCount, after, reverify)
      return {
        stopped: verdict === 'stopped',
        remaining: reverify < 0 ? after : reverify,
        verdict,
        note: stopVerdictText(verdict, before.processCount, after, reverify),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sister_restart',
    description: '重启孪生妹妹（先停后起，带 CDP）。用于让她的 profile 配置改动生效——她的 profile 是 Electron 独占的，改配置后必须重启才会重新读。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cdpReady: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          desktopVersion: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `妹妹已重启 · 状态 ${v.state} · CDP ${v.cdpReady ? '就绪' : '未就绪'}`
          + (v.desktopVersion !== '' ? ` · 版本 ${v.desktopVersion}` : ''),
      }],
    },
    async execute() {
      try { await runPs(stopScript(PROC_NAME)) } catch { /* 没在跑也无妨 */ }
      await new Promise((r) => setTimeout(r, 3_000))
      try {
        await runPs(detachLaunchScript(config.launchScript, config.exePath, config.cdpPort))
      } catch (e) {
        return { cdpReady: false, state: 'stopped', desktopVersion: '', note: '启动失败：' + String(e).slice(0, 200) }
      }
      const t0 = Date.now()
      let ready = false
      while (Date.now() - t0 < config.launchTimeoutMs) {
        await new Promise((r) => setTimeout(r, 1_500))
        if (await cdpVersion(config.cdpPort) !== null) { ready = true; break }
      }
      const after = await snapshot()
      log.info('restart done', after.state, ready)
      return {
        cdpReady: ready,
        state: after.state,
        desktopVersion: after.desktopVersion,
        note: ready
          ? 'CDP 就绪 ⇒ 配置已重读。若要看她是否入庄，查 cluster_nodes（本插件不管入册，那是 cluster 的事）'
          : '超时未见 CDP —— 先 sister_status 复核',
      }
    },
  }))

  log.info('ready · exe=' + config.exePath + ' cdpPort=' + config.cdpPort)
}
