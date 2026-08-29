// portfolio-check 工具：MCP stdio 桥。
// 在 asset-lens 项目里依次执行 make calculate / make analyze / make compare，
// 刷新本地持仓快照并扫描异常（如年化收益率为天文数字、产品级离群值、内置风险提示），
// 返回体检结论。作为 weekly-investment 技能的前置检查：先确认数据无误，再做复盘。
// 注册方法见同目录 README.md。数据源可用 ASSET_LENS_DIR 覆盖。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import { runServer, truncate } from './lib-mcp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// 从本文件逐级向上找含 invest-kit/apps/asset-lens 的仓库根，避免写死层级。
// 也可用环境变量 ASSET_LENS_DIR 显式指定。
function findAssetLens() {
  if (process.env.ASSET_LENS_DIR) return process.env.ASSET_LENS_DIR
  let dir = HERE
  for (let i = 0; i < 14; i++) {
    const cand = join(dir, 'invest-kit', 'apps', 'asset-lens')
    if (fs.existsSync(join(cand, 'Makefile'))) return cand
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return join(HERE, 'invest-kit', 'apps', 'asset-lens')
}

const ASSET_LENS = findAssetLens()
// 每个 make 步骤在冷缓存时可能很慢，留足余量。
const STEP_TIMEOUT_MS = 300_000
const STEP_MAX_BUFFER = 16 * 1024 * 1024
// 年化收益超过该值(%)视为异常（短周期暴利被年化所致，非真实可持续收益）。
const ANNUAL_RETURN_CAP = 10000

const execFileAsync = promisify(execFile)

async function portfolioCheck() {
  const steps = ['calculate', 'analyze', 'compare']
  const logs = [`数据目录：${ASSET_LENS}`, '']
  for (const step of steps) {
    logs.push(`🔄 make ${step} ...`)
    try {
      const { stdout, stderr } = await execFileAsync('make', [step], {
        cwd: ASSET_LENS,
        timeout: STEP_TIMEOUT_MS,
        maxBuffer: STEP_MAX_BUFFER,
        env: process.env,
      })
      const notable = `${stdout}\n${stderr}`
        .split('\n')
        .filter((l) => /[⚠❌]|异常|错误|过期|失败|error|warn/i.test(l))
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 20)
        .join('\n')
      if (notable) logs.push(notable)
    } catch (e) {
      const detail = (e.stderr ?? e.stdout ?? e.message ?? String(e)) || ''
      return `error: portfolio-check 在 make ${step} 阶段失败 — ${truncate(detail, 800)}`
    }
  }

  logs.push('', '## 体检结论')
  logs.push(scanAnomalies())
  return logs.join('\n')
}

// 读最新快照 JSON 并扫描数值异常。
function scanAnomalies() {
  const outDir = join(ASSET_LENS, 'output')
  let files
  try {
    files = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith('投资收益率分析_') && f.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return '⚠️ 未找到 asset-lens 生成的快照 JSON（output/投资收益率分析_*.json），请确认 make analyze 已成功执行。'
  }
  if (!files.length) return '⚠️ 未找到 asset-lens 生成的快照 JSON（output/投资收益率分析_*.json）。'

  const latest = join(outDir, files[0])
  let data
  try {
    data = JSON.parse(fs.readFileSync(latest, 'utf8'))
  } catch {
    return `⚠️ 无法解析快照文件：${latest}`
  }

  const lines = [`快照文件：${files[0]}（生成于 ${data.generated_at ?? '未知'}）`, '']
  const ev = data.comprehensive_evaluation ?? {}
  const w = parseFloat(String(ev.weighted_annual_return ?? '').replace('%', ''))
  if (!Number.isNaN(w) && Math.abs(w) > ANNUAL_RETURN_CAP) {
    lines.push(
      `- ⚠️ 加权年化收益率异常：${ev.weighted_annual_return}（合理上限约 ${ANNUAL_RETURN_CAP}%，疑似短周期暴利被年化，已失真）`,
    )
  } else {
    lines.push(`- 加权年化收益率：${ev.weighted_annual_return ?? 'N/A'}`)
  }
  lines.push(`- 整体收益率：${ev.overall_return_rate ?? 'N/A'}`)
  lines.push(`- 当前总资产：${ev.total_current_amount ?? 'N/A'}`)

  const prods = Array.isArray(data.products) ? data.products : []
  const outliers = prods
    .map((p) => ({
      name: p['名称'] ?? p.name ?? '?',
      ar: parseFloat(String(p['年化收益率(%)'] ?? p.annual_return ?? '').replace('%', '')),
    }))
    .filter((p) => !Number.isNaN(p.ar) && Math.abs(p.ar) > ANNUAL_RETURN_CAP)
  if (outliers.length) {
    lines.push(`- ⚠️ ${outliers.length} 只产品年化收益率异常（> ${ANNUAL_RETURN_CAP}%）：`)
    for (const o of outliers.slice(0, 10)) lines.push(`  - ${o.name}：${o.ar}%`)
  }

  const warns = data.risk_warnings
  if (Array.isArray(warns) && warns.length) {
    lines.push(`- 内置风险提示 ${warns.length} 条（详见快照 JSON 的 risk_warnings）`)
  }

  if (lines.length <= 3) lines.push('- ✅ 未发现明显数值异常')
  return lines.join('\n')
}

runServer({
  name: 'portfolio-check',
  version: '1.0.0',
  tools: [
    {
      name: 'portfolio-check',
      description:
        '投资前数据体检：在 asset-lens 项目里依次执行 make calculate / make analyze / make compare，' +
        '刷新本地持仓快照并扫描异常（如年化收益率为天文数字、产品级离群值、内置风险提示），返回体检结论。' +
        '作为 weekly-investment 技能的前置检查，确认数据无误后再做投资复盘。只读、无副作用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return portfolioCheck()
      },
    },
  ],
})
