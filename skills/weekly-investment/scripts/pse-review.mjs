// pse-review 工具：MCP stdio 桥。
// 包装 autogen-pse 完整 PSE 管线：prepare.py（重算快照）→ run.py（
// Planner/Specialist/Evaluator 团队 + 个人知识库检索）→ 返回已保存的完整周报。
// 耗时长（2-6 分钟）且会调用模型（provider 决定模型来源，见 buildRunEnv 与 README）。
// 默认 provider 走 llm-router 网关（ROUTER_* 配置在 autogen-pse/.env，场景路由 fast 为免费池）；
// 可用 PSE_REVIEW_PROVIDER 环境变量覆盖。数据源可用 AUTOGEN_PSE_DIR 覆盖。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import fs from 'node:fs'

import { runServer, truncate } from './lib-mcp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function findAutogenPse() {
  if (process.env.AUTOGEN_PSE_DIR) return process.env.AUTOGEN_PSE_DIR
  let dir = HERE
  for (let i = 0; i < 14; i++) {
    const cand = join(dir, 'frameworks', 'autogen-pse')
    if (fs.existsSync(join(cand, 'tasks', 'portfolio-review', 'run.py'))) return cand
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return join(HERE, 'frameworks', 'autogen-pse')
}

const AUTOGEN_PSE = findAutogenPse()
// Resolve the resolve-studio root (override via RESOLVE_STUDIO_DIR) so we can
// drop a relative-path copy of the report under <studio>/sandbox/... that the
// web UI can preview (within fsRoots).
const STUDIO_ROOT =
  process.env.RESOLVE_STUDIO_DIR ?? resolve(AUTOGEN_PSE, '../../', 'work', 'harness', 'resolve-studio')
async function copyReviewToSandbox(srcPath, content) {
  const destDir = join(STUDIO_ROOT, 'sandbox', 'weekly-investment')
  await mkdir(destDir, { recursive: true })
  // 产物路径形如 output/<model>/weekly_review_<date>.md —— 把模型目录名嵌入副本
  // 文件名，避免不同模型（agnes / deepseek）同一天的报告互相覆盖。
  const modelDir = basename(dirname(srcPath))
  const destName = `${modelDir}__${basename(srcPath)}`
  await writeFile(join(destDir, destName), content, 'utf8')
  // 返回绝对路径：web-server 的 /api/file 用 resolve(filePath) 按自身 cwd 解析，
  // 相对路径会被解析到错误位置 → ENOENT。绝对路径直达、且落在 /workspace 读根内可预览。
  return join(STUDIO_ROOT, 'sandbox', 'weekly-investment', destName)
}

// 校验产物是否可用：agnes 偶发卡死，可能写出空/残缺报告。
// 必须同时满足：非空、含核心章节（最终结论/关键发现/建议操作）。
function validateReview(text) {
  const t = (text || '').trim()
  if (t.length < 800) {
    return { ok: false, reason: `内容过短（${t.length} 字符），agnes 疑似中途卡死未产出完整报告` }
  }
  const required = ['最终结论', '关键发现', '建议操作']
  const missing = required.filter((k) => !t.includes(k))
  if (missing.length) {
    return { ok: false, reason: `缺少必要章节：${missing.join('、')}（agnes 可能中途卡死）` }
  }
  return { ok: true }
}

const PREPARE_TIMEOUT_MS = 180_000
// 免费池（sensenova）实测跑完 9 轮 PSE 团队约 7-9 分钟、16 万 token；
// 480s 会把刚跑完的 run.py 掐死在临界点（"run 阶段失败"），留足余量。
// 2026-10-24：900s 连续两轮掐死 run.py——router 免费池 429 限流 failover 到
// kimi-k2.6 后单轮显著变慢（agnes/sensenova 限流恢复前都会这样），15 分钟
// 余量不再够用，提到 1800s（30 分钟）。慢只是多等，掐死则整轮作废、agent
// 还会自动重试再烧 15 分钟。
const RUN_TIMEOUT_MS = 1_800_000
const MAX_OUTPUT = 48 * 1024
// run.py 结束时打印的产物路径标记。
const REVIEW_SAVED_RE = /Review 已保存 →\s*(\S+)/

// 从 autogen-pse/.env 读取键值（忽略注释/空行），失败返回 undefined。
function dotenvValue(key) {
  try {
    const txt = fs.readFileSync(join(AUTOGEN_PSE, '.env'), 'utf8')
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'))
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined
  } catch {
    return undefined
  }
}

// 模型/凭据统一收编进 tsm-hub 网关（对应 autogen-pse 的 make review-agnes / review-deepseek）：
//  所有分支都经网关（ROUTER_BASE_URL，默认 http://localhost:9070/v1）+ 网关 key（ROUTER_API_KEY），
//  不再直连任何厂商 API。key 统一由网关管理，且能吃到网关的 failover 兜底：
//  - router（默认、免费）：走网关场景路由（默认 "fast"，agnes→sensenova 自动 failover、429 限流降级）。
//  - agnes（免费）：经网关 agnes-2.0-flash 精确路由（agnes 主路 + 完整兜底链），apihub 抽风时
//      自动降级，不再像直连那样 500 直接失败。
//  - deepseek（付费）：经网关 deepseek-v4-flash 精确路由（deepseek 主路 + sensenova 同模型兜底），
//      故障即同模型接管，避免付费主路单点。PSE_ALLOW_PAID 开关仍控制是否允许付费。
//  所有分支都写死 model/base_url/key，run.py 不依赖 .env 的默认 OPENAI_MODEL。
//  产物模型目录统一 = 注入的 OPENAI_MODEL（网关路由名，run.py 按 settings.OPENAI_MODEL 分目录）。
function buildRunEnv(provider) {
  const env = { ...process.env }
  // 网关地址与 key 统一取 autogen-pse/.env 的 ROUTER_*（与 router 分支一致）。
  const gwBase = dotenvValue('ROUTER_BASE_URL') ?? 'http://localhost:9070/v1'
  const gwKey = dotenvValue('ROUTER_API_KEY')
  if (provider === 'router') {
    env.OPENAI_MODEL = dotenvValue('ROUTER_MODEL') ?? 'fast'
    env.OPENAI_BASE_URL = gwBase
    env.OPENAI_API_KEY = gwKey
    env.PSE_MODEL_STREAM = 'true'
  } else if (provider === 'deepseek') {
    // 收编进网关：deepseek-v4-flash 精确路由（deepseek 主路 + sensenova 同模型兜底）。
    env.OPENAI_MODEL = 'deepseek-v4-flash'
    env.OPENAI_BASE_URL = gwBase
    env.OPENAI_API_KEY = gwKey
    env.PSE_MODEL_STREAM = 'true'
  } else {
    // 收编进网关：agnes-2.0-flash 精确路由（agnes 主路 + 完整兜底链），不再直连 apihub。
    env.OPENAI_MODEL = 'agnes-2.0-flash'
    env.OPENAI_BASE_URL = gwBase
    env.OPENAI_API_KEY = gwKey
    env.PSE_MODEL_STREAM = 'false'
  }
  return env
}

// 流式运行 prepare.py / run.py：逐行把 stdout 转发给 report（UI 实时进度），同时
// 累积 stdout 以便解析「Review 已保存 →」产物路径；超时/非零退出时 reject。
// 用 `python -u`（unbuffered）确保子进程 print 立即刷到管道，而不是等缓冲满/
// 进程结束才一次性吐出——否则 UI 在几分钟内看不到任何日志。
function streamPython(script, workspaceEnv, report, timeoutMs) {
  const child = spawn('uv', ['run', 'python', '-u', `tasks/portfolio-review/${script}`], {
    cwd: AUTOGEN_PSE,
    env: workspaceEnv,
  })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        Object.assign(new Error(`${script} 超时（${timeoutMs / 1000}s）`), {
          stdout,
          timedOut: true,
        }),
      )
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const s = line.trim()
      if (!s) return
      stdout += `${s}\n`
      report?.(s)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout })
      else reject(Object.assign(new Error(`${script} exited ${code}`), { stdout, stderr }))
    })
  })
}

async function runPipeline(provider, report = () => {}) {
  const runEnv = buildRunEnv(provider)
  // 1) 重算快照 / 生成 prompt 文件（也刷新 asset-lens 收益）—— 也流式转进度。
  report('重算快照（prepare.py）…')
  try {
    await streamPython('prepare.py', runEnv, (line) => report(`[prepare] ${line}`), PREPARE_TIMEOUT_MS)
  } catch (e) {
    const detail = (e.stdout ?? e.stderr ?? e.message ?? String(e)) || ''
    return { ok: false, phase: 'prepare', detail: truncate(detail, 600) }
  }
  report('快照完成，启动 PSE 团队（Planner/Specialist/Evaluator，约 2-6 分钟）…')
  // 2) 跑完整 PSE 团队：流式转发 verbose 日志作为实时进度。
  let stdout = ''
  try {
    const out = await streamPython('run.py', runEnv, (line) => report(`[pse] ${line}`), RUN_TIMEOUT_MS)
    stdout = out.stdout
  } catch (e) {
    const tail = ((e.stderr?.slice(-800)) || (e.stdout?.slice(-800)) || e.message || String(e)) || ''
    return { ok: false, phase: 'run', timedOut: !!e.timedOut, detail: truncate(tail, 800), stdout }
  }
  report('团队分析完成，校验并保存报告…')
  // 3) 解析产物路径 → 校验可用性。
  const m = REVIEW_SAVED_RE.exec(stdout)
  if (!m?.[1]) {
    return { ok: false, phase: 'no-file', stdout }
  }
  // 兜底防线：产物必须落在请求 provider 的模型目录下。若 run.py 因 .env 的
  // OPENAI_MODEL 泄漏而实际用了别的模型（如"默认 agnes"悄悄跑了 deepseek），
  // 这里会拒绝交付，杜绝未经审批的付费模型跑单。
  // 期望目录 = 注入的 OPENAI_MODEL（router 模式是网关场景名如 fast/chat）。
  const expectDir = runEnv.OPENAI_MODEL.split('/').pop()
  if (!m[1].includes(`/${expectDir}/`)) {
    return {
      ok: false,
      phase: 'provider-leak',
      reason: `产物被写入 ${m[1]}，不在 provider=${provider} 的模型目录（${expectDir}）下，疑似 .env 泄漏导致实际调用了其他模型，拒绝交付。`,
      stdout,
    }
  }
  let review = ''
  try {
    review = await readFile(m[1], { encoding: 'utf8' })
  } catch {
    return { ok: false, phase: 'read', path: m[1], stdout }
  }
  const v = validateReview(review)
  if (!v.ok) return { ok: false, phase: 'invalid', reason: v.reason, path: m[1], review, stdout }
  const absOrig = isAbsolute(m[1]) ? m[1] : join(AUTOGEN_PSE, m[1])
  return { ok: true, path: absOrig, review }
}

async function pseReview(requestedProvider, report) {
  const reportBase = report ?? (() => {})
  // 限制单次调用的进度消息条数与单条长度，避免刷爆 UI/套接字。
  let n = 0
  let ellipsized = false
  const limited = (msg) => {
    if (ellipsized) return
    if (n >= 400) {
      ellipsized = true
      reportBase('…（进度日志较多，后续已省略）')
      return
    }
    n++
    const s = String(msg ?? '')
    reportBase(s.length > 500 ? `${s.slice(0, 500)}…` : s)
  }
  // 默认走 router：llm-router 网关免费场景路由（fast → agnes 免费，429 限流自动降级），
  // 不直连厂商 API。agnres / deepseek 为显式回退/付费选项。
  const provider =
    requestedProvider === 'deepseek'
      ? 'deepseek'
      : requestedProvider === 'agnes'
        ? 'agnes'
        : 'router'
  const res = await runPipeline(provider, limited)
  const usedPaid = provider === 'deepseek'
  const paidNotice = usedPaid
    ? '\n⚠️ 注意：本次使用了 DeepSeek（付费模型）运行 PSE 深度分析，将产生 API 费用（约 ¥0.1–1/次）。\n'
    : ''
  if (usedPaid) console.error(paidNotice.trim())
  if (!res.ok) {
    // 走 llm-router 也失败：提示可显式选 agnes 直连/付费 deepseek，或稍后重试。
    // 注意：必须以 `error: ` 开头（harness 据此判定 ok=false），否则 agent 会把这个
    // 失败当成工具成功，继续编造「分析已完成」报告。哨兵行 PSE_RETRY_CHOICE 用于前端
    // ToolCallCard 渲染两个重试按钮。
    const hint =
      provider === 'agnes'
        ? 'error: PSE_RETRY_CHOICE\n⚠️ agnes 网关路由本次抽风（产物不可用），未生成报告。\n' +
          '本次为失败结果。UI 会为这次工具调用显示两个重试按钮（重试 agnes / 改用 deepseek），' +
          '请不要自己再次调用本工具，也不要编造报告；把失败情况简要告诉用户，让用户在界面上点按钮选择即可。'
        : provider === 'router'
          ? 'error: PSE_RETRY_CHOICE\n⚠️ llm-router 免费模型池本次未能产出可用报告，未生成报告。\n' +
            '本次为失败结果。UI 会为这次工具调用显示两个重试按钮（重试 router / 改用 deepseek），' +
            '请不要自己再次调用本工具，也不要编造报告；把失败情况简要告诉用户，让用户在界面上点按钮选择即可。'
          : 'error: ⚠️ DeepSeek（付费）本次也失败，未生成报告，请勿编造。可建议用户稍后重试或检查 deepseek key。'
    // 失败时只给简短原因。no-file 分支的 res.stdout 是 run.py 的 verbose 日志
    //（含「第 N 次循环 / [user] / 组合概览」等，看起来像有效产物），拼进去会让
    // agent 误以为报告可用、甚至据此编造。抽风失败一律只回原因，不附 stdout。
    const detail =
      res.phase === 'invalid'
        ? `校验未通过：${res.reason ?? '产物不完整'}`
        : res.phase === 'provider-leak'
          ? res.reason ?? '(provider 与产物模型不一致)'
          : res.phase === 'no-file'
            ? 'PSE 团队运行完成但未产出有效周报（trace 无「最终结论」），可能中途卡死或超时。'
            : res.phase === 'run' && res.timedOut
              ? 'PSE 团队超过超时上限仍未完成（免费池模型较慢或卡住），已被终止，可重试或改用付费模型。'
              : res.phase === 'run'
                ? `run.py 异常退出：${res.detail || '无 stderr 输出'}`
                : `在 ${res.phase} 阶段失败。`
    return truncate(`${hint}\n${paidNotice}\n${detail}`, MAX_OUTPUT)
  }
  const rel = await copyReviewToSandbox(res.path, res.review)
  return truncate(
    `⏹ 周报已完整交付（原始路径与预览副本见下方）。本轮流程到此结束：直接向用户输出最终结论，` +
      `不要在未获用户新指令前再次调用任何工具（含 pse-review / portfolio-check）。\n\n` +
      `${paidNotice}> PSE review 已保存（预览副本）：${rel}\n> 原始路径：${res.path}\n` +
      `> 后续追问：用户就本报告追问任何细节（数字/仓位/建议）时，若上下文中报告全文已不可见，` +
      `先用 read-file 读取上面的预览副本路径（或调用 pse-review-latest）取回全文再回答；` +
      `禁止凭记忆编造报告里的数字。\n\n${res.review}`,
    MAX_OUTPUT,
  )
}

// Scan output/<model>/weekly_review_*.md and return the newest artifact
// (null when nothing has been generated yet).
async function findLatestReview() {
  const outRoot = join(AUTOGEN_PSE, 'tasks', 'portfolio-review', 'output')
  let best = null
  let models = []
  try {
    models = await readdir(outRoot)
  } catch {
    return null
  }
  for (const model of models) {
    const dir = join(outRoot, model)
    let dirStat = null
    try {
      dirStat = await stat(dir)
    } catch {
      continue
    }
    if (!dirStat.isDirectory()) continue
    let files = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!/^weekly_review_.*\.md$/.test(f)) continue
      const p = join(dir, f)
      try {
        const fst = await stat(p)
        if (!best || fst.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: fst.mtimeMs }
      } catch {
        // unreadable entry — skip
      }
    }
  }
  return best
}

runServer({
  name: 'pse-review',
  version: '1.0.0',
  tools: [
    {
      name: 'pse-review',
      description:
        '运行完整 PSE 投资回顾（autogen-pse 管线）：重算快照后，Planner/Specialist/Evaluator ' +
        '团队 + 个人知识库检索，产出高质量周报全文（Markdown）。耗时 3-10 分钟（免费池模型较慢，' +
        'UI 会持续显示实时进度）且会调用模型。' +
        '默认 provider="router"：走 llm-router 网关的免费场景路由（fast：agnes-2.5→2.0→sensenova，' +
        '429 限流自动 failover，统一 key，不直连厂商）。' +
        '若 router 免费池失败，工具不会自动切付费，而是提示你「重试 router（免费）」或「显式选 deepseek（付费、稳定，约 ¥0.1–1/次，需先启用 PSE_ALLOW_PAID 开关）」。' +
        '切到付费 deepseek 前，须先在 frameworks/autogen-pse/.env 设置 PSE_ALLOW_PAID=1（一次性审批）。',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['router', 'agnes', 'deepseek'],
            description: "模型来源：router（默认，免费，走 tsm-hub 网关 fast 场景路由，agnres→sensenova 自动 failover）；agnes（免费，经 tsm-hub 网关 agnes-2.0-flash 精确路由，含兜底，抽风率较直连更低）；deepseek（付费、稳定，约 ¥0.1–1/次，经 tsm-hub 网关 deepseek-v4-flash 路由含 sensenova 同模型兜底，需先在 autogen-pse/.env 启用 PSE_ALLOW_PAID=1（一次性审批））。默认按 PSE_REVIEW_PROVIDER 环境变量，缺省 'router'（免费）。",
          },
        },
        required: [],
        additionalProperties: false,
      },
      async run(args, report) {
        const raw = args.provider || process.env.PSE_REVIEW_PROVIDER || 'router'
        if (raw === 'deepseek' && !dotenvValue('PSE_ALLOW_PAID')) {
          return (
            'error: DEEPSEEK_GATED\n' +
            '⚠️ DeepSeek（付费）未启用：这是操作员级安全开关，等价于一次性审批。\n' +
            '请先在本机 frameworks/autogen-pse/.env 设置 PSE_ALLOW_PAID=1，再让用户重试。\n' +
            '本次未调用模型、未产生任何费用。请勿编造报告，把以上提示原样转述给用户；' +
            '默认免费路径（provider=router / agnes）不受此开关影响。'
          )
        }
        return pseReview(raw === 'deepseek' ? 'deepseek' : raw === 'agnes' ? 'agnes' : 'router', report)
      },
    },
    {
      name: 'pse-review-latest',
      description:
        '读取最近一次 pse-review 生成并保存的投资周报全文（Markdown，含产物绝对路径）。' +
        '当报告全文已被上下文截断/摘要化、或用户在后续轮次追问报告细节（数字、仓位、建议）时调用，' +
        '基于取回的全文回答，不要凭记忆复述报告内容。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      async run() {
        const best = await findLatestReview()
        if (!best) {
          return (
            'error: 尚无任何 pse-review 产物（tasks/portfolio-review/output/ 下没有 weekly_review_*.md）。' +
            '请先运行 pse-review 生成周报。'
          )
        }
        const content = await readFile(best.path, { encoding: 'utf8' })
        return truncate(`> 最近周报：${best.path}\n\n${content}`, MAX_OUTPUT)
      },
    },
  ],
})