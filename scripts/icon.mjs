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
  const pkg = readPkg()
  pkg.magpie ??= {}
  const have = pkg.magpie.icon ?? ""
  if (have === want) {
    console.log(`magpie.icon 与 icon.svg 同步（${want.length} 字节）`)
    return 0
  }
  if (check) {
    console.error("magpie.icon 与 icon.svg 不同步，跑 `node scripts/icon.mjs` 修好")
    return 1
  }
  pkg.magpie.icon = want
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
  console.log(`magpie.icon 已写入（${want.length} 字节）`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
