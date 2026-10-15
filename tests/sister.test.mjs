/**
 * dsh-agent-sister 纯决策层套件。
 *
 * 本插件此前 **0 个测试**（2026-09-30 实测 `tests 0 / pass 0 / fail 0`）——补这一套是还债。
 * 只测纯函数（无 IO、不碰生产资产）；IO 层（runPs / processCount / cdpVersion）不在此列。
 * 锚点是一条**尸体样本**：2026-09-30 12:55 的真实读数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideAlive, decideStopVerdict, detachLaunchScript, parseDesktopVersion, processCountScript, stopScript,
  stopVerdictText,
} from '../lib/index.js'

test('processCountScript / stopScript：进程名含空格 ⇒ 必须单引号包裹', () => {
  const c = processCountScript('DeepSeek Harness')
  assert.match(c, /'DeepSeek Harness'/, '不引号会被 Get-Process 拆成两个参数')
  const s = stopScript('DeepSeek Harness')
  assert.match(s, /'DeepSeek Harness'/)
  assert.match(s, /Stop-Process -Force/)
})

test('decideAlive：CDP 可达=alive；无 CDP 有进程=starting；都没有=stopped', () => {
  assert.equal(decideAlive(5, true), 'alive')
  assert.equal(decideAlive(5, false), 'starting', 'Host 懒启动的中间态必须单列，不能算 alive')
  assert.equal(decideAlive(0, false), 'stopped')
  assert.equal(decideAlive(0, true), 'alive', 'CDP 可达优先于进程数（进程枚举可能漏）')
})

test('parseDesktopVersion：命中 / 未命中 / 空串', () => {
  assert.equal(parseDesktopVersion('Mozilla/5.0 Chrome/152 dsh-desktop/0.2.0-rc.2 Safari/537'), '0.2.0-rc.2')
  assert.equal(parseDesktopVersion('Chrome/152'), '')
  assert.equal(parseDesktopVersion(''), '')
})

test('detachLaunchScript：必须走 WMI 脱离进程树，**不许再退回 Start-Process**', () => {
  const s = detachLaunchScript('C:\\x\\launch.cmd', 'C:\\y\\App.exe', 9333)
  assert.match(s, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/)
  assert.ok(
    !s.includes('Start-Process'),
    'Start-Process 起的进程仍是调用者的后代 ⇒ web 重启的清理会连带杀她（2026-09-30 12:51 / 18:07 两次实测）',
  )
  assert.ok(s.includes('launch.cmd'), 'WMI 不继承调用者环境 ⇒ 环境与留痕必须由启动器脚本负责')
  assert.ok(s.includes('9333'), '端口要真的传下去（她的身份 id 里含端口）')
  assert.ok(s.includes('App.exe'))
})

test('decideStopVerdict 尸体样本：kill 后仍有进程存活，不许判成「已停止」（2026-09-30 12:55 实录）', () => {
  // 事故读数：工具回「已停止妹妹 · 剩余进程 5」，而她实际 5 个进程全在。
  assert.equal(decideStopVerdict(5, 5, 5), 'residual')
  // 只数一次会误判：第一次 0（进程正在退），复检又冒出 3 个 ⇒ 仍不算停住。
  assert.equal(decideStopVerdict(5, 0, 3), 'residual', '复检窗口不可省')
  // 两次都为 0 才算停住。
  assert.equal(decideStopVerdict(5, 0, 0), 'stopped')
  // -1 = 查询失败（未知），不是 0 ⇒ 不许下结论。
  assert.equal(decideStopVerdict(5, -1, 2), 'unknown')
  assert.equal(decideStopVerdict(5, 0, -1), 'unknown')
  // 「本来就没跑」与「这次停住了」分开报。
  assert.equal(decideStopVerdict(0, 0, 0), 'already-stopped')
})

test('stopVerdictText：**结论行由纯函数产出，residual/unknown 时不许出现「已停止」**', () => {
  const residual = stopVerdictText('residual', 5, 5, 5)
  assert.ok(!residual.includes('已停止'), '这就是事故里骗人的那行字，必须钉死')
  assert.ok(residual.includes('未停止'))
  assert.ok(residual.includes('5'), '读数要留在结论里，便于事后比对')

  const unknown = stopVerdictText('unknown', 5, -1, 2)
  assert.ok(!unknown.includes('已停止'))
  assert.ok(unknown.includes('未停止'))

  const stopped = stopVerdictText('stopped', 5, 0, 0)
  assert.ok(stopped.includes('已停止'))
  assert.ok(!stopped.includes('未停止'))

  const already = stopVerdictText('already-stopped', 0, 0, 0)
  assert.ok(already.includes('本来就没在跑'))
  assert.ok(!already.includes('未停止'), '没在跑 ≠ 停止失败，措辞必须分开')
})
