#!/usr/bin/env node
/**
 * dsh-pet-notepad 安装器 —— 把本目录装配进 DSH 的 profile。
 *
 * 为什么需要它：DSH 只加载 profile 的 `dsh.profile.bundles` 列表里显式列出的包
 * （见 dsh-app-boot 的 profile 文档："the tree is composed by applying each
 * bundle's patch lists in dsh.profile.bundles order over an empty entry list"）。
 * `dsh plugin add` 只是 pnpm 的转发，它把包装进 node_modules，**不会**往 bundles
 * 里加名字 —— 少这一步，插件装了也不生效。本脚本把两步一起做掉。
 *
 * 用法：
 *   node install.mjs                       # 装进 profile "web"（DSH 默认）
 *   node install.mjs --profile myprofile
 *   node install.mjs --dry-run             # 只打印将做什么，不落盘
 *   node install.mjs --dsh-home /path/.dsh # 指定 DSH 主目录（多机/测试用）
 *
 * 卸载：
 *   node install.mjs --uninstall
 *
 * 装完需要重启 `dsh web` 让 profile 重新装配。
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包名（必须与 package.json 的 name 一致）。 */
const PKG_NAME = '@dsh-external/dsh-pet-notepad'

/** 本仓库根目录（脚本所在目录）。 */
const PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { profile: 'web', dshHome: undefined, dryRun: false, uninstall: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--uninstall') out.uninstall = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--profile') out.profile = argv[++i]
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length)
    else if (arg === '--dsh-home') out.dshHome = argv[++i]
    else if (arg.startsWith('--dsh-home=')) out.dshHome = arg.slice('--dsh-home='.length)
    else {
      console.error(`未知参数：${arg}`)
      process.exit(1)
    }
  }
  if (!out.profile) {
    console.error('--profile 需要一个值')
    process.exit(1)
  }
  return out
}

/** DSH 主目录：--dsh-home > $DSH_HOME > ~/.dsh。 */
function resolveDshHome(explicit) {
  if (explicit) return resolve(explicit)
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim())
  return join(homedir(), '.dsh')
}

/** 把绝对路径写成 package.json 里的 link: 形式（统一正斜杠，跨平台一致）。 */
function toLinkSpec(dir) {
  return 'link:' + dir.replace(/\\/g, '/')
}

const HELP = `dsh-pet-notepad 安装器

用法:
  node install.mjs [选项]

选项:
  --profile <name>    目标 profile（默认 web）
  --dsh-home <path>   DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --dry-run           只打印将要做的事，不写任何文件
  --uninstall         从 profile 移除本插件
  -h, --help          显示本帮助

装完重启 dsh web 生效。`

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(HELP)
  process.exit(0)
}

const dshHome = resolveDshHome(opts.dshHome)
const profileDir = join(dshHome, 'profiles', opts.profile)
const profilePkgPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', '@dsh-external', 'dsh-pet-notepad')

console.log('dsh-pet-notepad 安装器')
console.log('  本包目录 : ' + PKG_DIR)
console.log('  DSH 主目录: ' + dshHome)
console.log('  profile  : ' + opts.profile + '  (' + profileDir + ')')
if (opts.dryRun) console.log('  模式     : dry-run（不写入）')
console.log('')

// ---------- 前置检查 ----------
if (!existsSync(profilePkgPath)) {
  console.error('找不到 profile：' + profilePkgPath)
  console.error('')
  console.error('这个 profile 还不存在。先启动一次对应的 DSH 服务让它初始化，例如：')
  console.error('  dsh web            # 初始化并使用 "web" profile')
  console.error('然后重跑本脚本。')
  process.exit(1)
}

if (!existsSync(join(PKG_DIR, 'lib', 'index.js'))) {
  console.error('本包缺少 lib/index.js —— 请确认在完整仓库目录里运行本脚本。')
  process.exit(1)
}

let profilePkg
try {
  profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
} catch (error) {
  console.error('profile 的 package.json 无法解析：' + String(error))
  console.error('为避免破坏，已中止，未做任何修改。')
  process.exit(1)
}

profilePkg.dependencies = profilePkg.dependencies ?? {}
profilePkg.dsh = profilePkg.dsh ?? {}
profilePkg.dsh.profile = profilePkg.dsh.profile ?? {}
profilePkg.dsh.profile.bundles = Array.isArray(profilePkg.dsh.profile.bundles)
  ? profilePkg.dsh.profile.bundles
  : []

const bundles = profilePkg.dsh.profile.bundles
const alreadyInBundles = bundles.includes(PKG_NAME)
const previousDep = profilePkg.dependencies[PKG_NAME]

// ---------- 执行 ----------
if (opts.uninstall) {
  let changed = false
  if (alreadyInBundles) {
    profilePkg.dsh.profile.bundles = bundles.filter((name) => name !== PKG_NAME)
    changed = true
    console.log('- 从 dsh.profile.bundles 移除 ' + PKG_NAME)
  } else {
    console.log('= dsh.profile.bundles 里本来就没有它')
  }
  if (previousDep !== undefined) {
    delete profilePkg.dependencies[PKG_NAME]
    changed = true
    console.log('- 从 dependencies 移除 ' + PKG_NAME)
  }
  if (existsSync(linkPath)) {
    if (!opts.dryRun) rmSync(linkPath, { recursive: true, force: true })
    changed = true
    console.log('- 删除 node_modules 链接')
  }
  if (changed && !opts.dryRun) writeProfilePkg(profilePkg, profilePkgPath)
  console.log('')
  console.log(changed ? '✅ 已卸载。重启 dsh web 生效。' : '✅ 本来就没装。')
  console.log('注意：记事本数据仍在 ' + join(dshHome, 'pet-notepad', 'notepad.json') + '，如需彻底清除请手动删除。')
  process.exit(0)
}

// dependencies
const linkSpec = toLinkSpec(PKG_DIR)
if (previousDep === linkSpec) {
  console.log('= dependencies 已指向本目录')
} else {
  profilePkg.dependencies[PKG_NAME] = linkSpec
  console.log((previousDep === undefined ? '+ dependencies 新增 ' : '+ dependencies 更新 ') + PKG_NAME + ' → ' + linkSpec)
}

// bundles（关键的一步）
if (alreadyInBundles) {
  console.log('= dsh.profile.bundles 已包含（顺序保持不动）')
} else {
  bundles.push(PKG_NAME)
  console.log('+ dsh.profile.bundles 追加 ' + PKG_NAME + '（这是 DSH 真正加载插件的依据）')
}

if (opts.dryRun) {
  console.log('')
  console.log('dry-run：以上改动未写入。去掉 --dry-run 真正执行。')
  process.exit(0)
}

// 备份 + 写回
writeProfilePkg(profilePkg, profilePkgPath)

// node_modules 链接
const linkState = inspectLink(linkPath)
if (linkState === 'same') {
  console.log('= node_modules 链接已就位')
} else {
  if (linkState !== 'absent') rmSync(linkPath, { recursive: true, force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(PKG_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  console.log('+ 建立 node_modules 链接')
}

console.log('')
console.log('✅ 安装完成。')
console.log('   下一步：重启 dsh web（或在你已运行的 GUI 里让 agent 执行')
console.log('   dev_reload_package {"packageName":"dsh-pet-notepad"} 做热重载）。')
console.log('   然后刷新页面：左侧栏出现「记事本」，右键桌宠弹出悬浮记事本。')

/**
 * 写回 profile 的 package.json，先备份。
 * 内容与磁盘上完全一致时不写盘、不产生备份 —— 重复运行不留垃圾文件。
 * @param {object} pkg 已改好的对象
 * @param {string} file 目标文件
 */
function writeProfilePkg(pkg, file) {
  const next = JSON.stringify(pkg, null, 2) + '\n'
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = ''
  }
  if (current === next) {
    console.log('   （内容无变化，未写盘）')
    return
  }
  const backup = file + '.bak-' + Date.now()
  copyFileSync(file, backup)
  writeFileSync(file, next, 'utf8')
  console.log('   （原文件已备份为 ' + backup + '）')
}

/**
 * 判断 node_modules 链接现状。
 * @returns {'absent' | 'same' | 'other'}
 */
function inspectLink(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return 'absent'
  }
  try {
    const real = realpathSync(stat.isSymbolicLink() ? path : path)
    return real === realpathSync(PKG_DIR) ? 'same' : 'other'
  } catch {
    // 悬空链接：realpath 会抛错，按 other 处理（重建）
    return 'other'
  }
}
