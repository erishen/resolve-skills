#!/usr/bin/env node
/**
 * Random-comment helper for the post-comment skill.
 *
 * Two modes:
 *   --pick                              pick a random published post, print id/title/link
 *   --post <id> --content "<text>"      post a comment on that post
 *       [--name ".."] [--email ".."]    commenter identity (defaults below)
 *
 * Talks to the WordPress REST API of erishen.cn (override with ERISHEN_BASE).
 * Zero dependencies — uses Node's global fetch. No credentials are stored:
 * anonymous comment creation must be allowed by the site; if the API rejects
 * the request (e.g. Wordfence / rest_cannot_create) the raw error is printed
 * and the skill reports it instead of guessing.
 */

import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件位置 → 技能目录 → resolve-skills 仓库根。
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = resolve(SCRIPTS_DIR, '..')
const REPO_ROOT = resolve(SKILL_DIR, '../..')

const BASE = process.env.ERISHEN_BASE ?? 'https://erishen.cn'
const WP = `${BASE}/wp-json/wp/v2`
const DEFAULT_NAME = '程序猿小林'
const DEFAULT_EMAIL = 'noreply@example.com'

// 凭据加载：顺序 --env-dir → <cwd>/.env → resolve-skills 根/.env，均不覆盖已有变量。
function loadEnvNoOverride(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
{
  // 候选顺序（均不覆盖已存在变量）：HARNESS_SKILLS_ENV 显式文件 →
  // --env-dir 目录 → ~/.config/resolve-skills/.env（稳定本机位置，任意 checkout 都认）→
  // <cwd>/.env → 本仓库根/.env。后四项解决「submodule 不带 .env」的问题。
  const explicit = has('--env-dir') && arg('--env-dir') ? `${arg('--env-dir')}/.env` : undefined
  const envVarFile = process.env.HARNESS_SKILLS_ENV || undefined
  const homeCfg = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'resolve-skills', '.env')
    : join(os.homedir(), '.config', 'resolve-skills', '.env')
  for (const f of [
    envVarFile,
    explicit,
    homeCfg,
    join(process.cwd(), '.env'),
    join(REPO_ROOT, '.env'),
  ]) {
    if (f) loadEnvNoOverride(f)
  }
}

// Optional auth for sites that require login to comment (comment_registration).
// Credentials come ONLY from the environment / .env — never hardcoded.
// Reuses the project's existing PROD_WORDPRESS_* variables (fall back to
// ERISHEN_WP_*), sent as HTTP Basic auth.
const wpUser = process.env.PROD_WORDPRESS_USERNAME ?? process.env.ERISHEN_WP_USER
const wpAppPassword = process.env.PROD_WORDPRESS_APP_PASSWORD ?? process.env.ERISHEN_WP_APP_PASSWORD
const authHeader =
  wpUser && wpAppPassword
    ? `Basic ${Buffer.from(`${wpUser}:${wpAppPassword}`).toString('base64')}`
    : undefined

// 调试/零副作用模式：只报告凭据是否就位（布尔，绝不打印值）。
if (has('--env-check')) {
  console.log(
    JSON.stringify({
      wpUser: !!wpUser,
      wpAppPassword: !!wpAppPassword,
      auth: !!authHeader,
    }),
  )
  process.exit(0)
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}
function has(name) {
  return process.argv.includes(name)
}
function die(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

async function pick() {
  // orderby=rand is disabled on this site (400), so fetch a batch and pick
  // locally — random enough for our purpose.
  const res = await fetch(`${WP}/posts?per_page=100&status=publish`)
  if (!res.ok) die(`list posts failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  const posts = await res.json()
  if (!Array.isArray(posts) || posts.length === 0) die('no published posts found')
  const p = posts[Math.floor(Math.random() * posts.length)]
  console.log(JSON.stringify({ id: p.id, title: (p.title?.rendered ?? '').trim(), link: p.link }))
}

async function post(postId, name, email, content) {
  if (!content) die('--content is required')
  // Anonymous commenters use author_name/author_email; `author` is a user ID
  // (integer) and gets rejected by the REST API when given a string.
  const res = await fetch(`${WP}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({ post: postId, author_name: name, author_email: email, content }),
  })
  const text = await res.text()
  if (!res.ok) die(`post comment failed: ${res.status} ${text.slice(0, 300)}`)
  const c = JSON.parse(text)
  console.log(JSON.stringify({ id: c.id, status: c.status, post: c.post, link: c.link }))
}

if (has('--pick')) {
  await pick()
} else if (has('--post')) {
  const id = Number(arg('--post'))
  if (!Number.isInteger(id) || id <= 0) die('--post requires a numeric post id')
  await post(id, arg('--name') ?? DEFAULT_NAME, arg('--email') ?? DEFAULT_EMAIL, arg('--content'))
} else {
  die('usage: random-comment.mjs --pick | --post <id> --content "<text>" [--name ..] [--email ..]')
}
