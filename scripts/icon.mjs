#!/usr/bin/env node
/**
 * 把 `icon.svg` 内联成 `package.json` 的 `magpie.icon`（data:image/svg+xml URI）。
 *
 * ## 为什么要内联
 *
 * provider 卡片的图标只有两条读取链（`internal/plugin/host.js` 的 `iconOf()`）：
 * `auth.icon`（插件 auth 钩子里的字段）或 `package.json` 的 `magpie.icon`。
 * 两者都必须匹配 `/^(https:\/\/|data:image\/)/i` —— **相对文件路径不合格**，
 * 而被静默丢弃（列表里就只剩一个首字母方块）。长度上限 `3 << 19` = 1.5 MB。
 *
 * 用 data URI 而不是 https URL：插件可能是从本地目录装的（`magpie plugin add ./`），
 * 也可能装在完全断网的机器上；指向 GitHub 的原始地址会让图标依赖网络，且
 * 每次列表刷新都去拉一次第三方请求。内联之后图标与包一起走，没有这两种副作用。
 *
 * 不用 `magpie.page.icon` 代替：那是**页面**的图标（相对页面目录的文件，由
 * `internal/plugin/page.go` 换算），和 provider 卡片完全不相通。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/icon.mjs          # 写回 package.json
 * node scripts/icon.mjs --check  # 只校验是否与 icon.svg 同步，不同步则 exit 1
 * ```
 *
 * `npm test` 会调用 `--check`，所以改了 icon.svg 忘了同步会红。
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const svgPath = path.join(root, "icon.svg")
const pkgPath = path.join(root, "package.json")

/** magpie 接受的长度上限（`host.js`：`s.length <= 3 << 19`）。 */
export const MAX_ICON = 3 << 19

/**
 * SVG → data URI。
 *
 * 先压掉换行与行内空白：SVG 里的注释与缩进对渲染毫无用处，却要按 4/3 进 base64。
 * 只压 `>  <` 之间的空白，属性值内的空格不能动（`stroke-width="1.6"` 之类不受影响，
 * 但 `<text>` 内容里的空格有意义，故不碰标签内部）。
 */
export function dataUriOf(svg) {
  const squeezed = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim()
  return "data:image/svg+xml;base64," + Buffer.from(squeezed, "utf8").toString("base64")
}

/**
 * 渠道图标：`icons/<id>.svg` → `src/icons.mjs` 里对应的常量。
 *
 * 单一真源是那五个 SVG，base64 只是产物。这里按 `PROVIDER_ICONS`
 * （`src/icons.mjs` 自己导出）把两者对上，所以新增一家渠道只需三处：
 * 建 SVG、在 `src/icons.mjs` 加常量与映射、在 auth hook 里 `icon:`。
 */
const iconsDir = path.join(root, "icons")
const iconsModulePath = path.join(root, "src", "icons.mjs")

/** 从 src/icons.mjs 里读出 `PROVIDER_ICONS` 映射（不 import，避免循环依赖与缓存）。 */
function providerIconMap() {
  const src = fs.readFileSync(iconsModulePath, "utf8")
  const block = src.slice(src.indexOf("export const PROVIDER_ICONS"))
  return [...block.matchAll(/["']?([\w-]+)["']?\s*:\s*["'](\w+)["']/g)].map((m) => ({
    provider: m[1],
    constant: m[2],
  }))
}

/**
 * 把 `src/icons.mjs` 里 `export const <name> =` 之后的那段 data URI 换掉。
 *
 * 用「常量名 + 到下一个 `export const` 之间」定位，而不是整文件正则替换，
 * 这样常量顺序、注释、映射表都不会被动到。
 */
function replaceConstant(src, name, uri) {
  const start = src.indexOf(`export const ${name} =`)
  if (start < 0) return null
  const next = src.indexOf("export const", start + 1)
  const end = next < 0 ? src.length : next
  const chunk = src.slice(start, end)
  const replaced = chunk.replace(/["']data:image\/[^"']*["']/, JSON.stringify(uri))
  // base64 里可能出现任何字母；`$` 不该出现在 data URI 中，但仍按字面量替换，
  // 避免 String.replace 把 `$&` 这类序列当替换模式。
  if (replaced === chunk) return null
  return src.slice(0, start) + replaced + src.slice(end)
}

function syncProviderIcons(check) {
  const map = providerIconMap()
  if (map.length === 0) {
    console.error("src/icons.mjs 里读不到 PROVIDER_ICONS")
    return 1
  }
  let src = fs.readFileSync(iconsModulePath, "utf8")
  let problems = 0
  for (const { provider, constant } of map) {
    const svgFile = path.join(iconsDir, `${provider}.svg`)
    if (!fs.existsSync(svgFile)) {
      console.error(`缺 ${path.relative(root, svgFile)}（provider ${provider} 的 auth.icon 源文件）`)
      problems++
      continue
    }
    const want = dataUriOf(fs.readFileSync(svgFile, "utf8"))
    if (want.length > MAX_ICON) {
      console.error(`${provider}.svg 内联后 ${want.length} 字节，超过 magpie 的 ${MAX_ICON} 字节上限`)
      problems++
      continue
    }
    const next = replaceConstant(src, constant, want)
    if (next === null) {
      // 常量不存在或已经与 SVG 完全一致（chunk 里没有可替换的 data URI 时返回 null）
      if (!src.includes(`export const ${constant} =`)) {
        console.error(`src/icons.mjs 里没有 export const ${constant}`)
        problems++
      }
      continue
    }
    src = next
  }
  if (problems) return 1
  const current = fs.readFileSync(iconsModulePath, "utf8")
  if (current === src) {
    console.log(`providers 图标与 icons/*.svg 同步（${map.length} 个）`)
    return 0
  }
  if (check) {
    console.error("src/icons.mjs 与 icons/*.svg 不同步，跑 `node scripts/icon.mjs` 修好")
    return 1
  }
  fs.writeFileSync(iconsModulePath, src)
  console.log(`providers 图标已更新（${map.length} 个）`)
  return 0
}

function readPkg() {
  return JSON.parse(fs.readFileSync(pkgPath, "utf8"))
}

function main(argv) {
  const check = argv.includes("--check")
  const svg = fs.readFileSync(svgPath, "utf8")
  const want = dataUriOf(svg)
  if (want.length > MAX_ICON) {
    console.error(`icon.svg 内联后 ${want.length} 字节，超过 magpie 的 ${MAX_ICON} 字节上限`)
    return 1
  }
  const iconProblems = syncProviderIcons(check)
  const pkg = readPkg()
  pkg.magpie ??= {}
  const have = pkg.magpie.icon ?? ""
  let pkgProblems = 0
  if (have === want) {
    console.log(`magpie.icon 与 icon.svg 同步（${want.length} 字节）`)
  } else if (check) {
    console.error("magpie.icon 与 icon.svg 不同步，跑 `node scripts/icon.mjs` 修好")
    pkgProblems++
  } else {
    pkg.magpie.icon = want
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    console.log(`magpie.icon 已写入（${want.length} 字节）`)
  }
  return iconProblems || pkgProblems ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
