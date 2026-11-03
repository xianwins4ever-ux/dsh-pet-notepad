# dsh-pet-notepad

DSH Web GUI 的**桌宠伴生记事本**：右键桌宠弹出一块悬浮记事本，就挂在宠物正下方；左侧栏另有一个「记事本」入口，随时查看/编辑同一份内容。

- **单块纯文本** —— 没有卡片、没有标签、没有定时、不跑 agent。粘贴即存。
- **Host 权威** —— 内容存在 Host 侧的 JSON 文件里，浏览器只是视图。刷新、重开浏览器、换标签页都不丢。
- **零构建** —— `lib/*.js` 就是最终产物，不需要 tsc/tsdown，也不需要 DSH 源码 checkout。
- **零依赖** —— 不 import 桌宠插件，只认它留在 DOM 上的一个标记，所以桌宠更新后照常可用。

![效果](https://img.shields.io/badge/DSH-%E6%A1%8C%E5%AE%A0%E4%BC%B4%E7%94%9F%E8%AE%B0%E4%BA%8B%E6%9C%AC-blue)

---

## 前置要求

| 项 | 要求 |
|---|---|
| DSH | `>=0.1.7-rc.1`（Web GUI，即 `dsh web`） |
| Node.js | `^22.19.0` 或 `>=24` |
| 桌宠插件 | 建议安装 [`@linxin666/dsh-pet`](https://www.npmjs.com/package/@linxin666/dsh-pet)（**没装也能用**，只是右键宠物这个入口失效，左侧栏入口照常） |

## 安装

```bash
git clone https://github.com/xianwins4ever-ux/dsh-pet-notepad.git
cd dsh-pet-notepad
node install.mjs
```

然后重启 `dsh web`。刷新页面后：左侧栏出现「记事本」，右键桌宠弹出悬浮记事本。

安装器会做两件事（**第二件是关键**）：

1. 往 profile 的 `dependencies` 加一条 `link:<本目录>`；
2. 把本包名写进 profile 的 `dsh.profile.bundles`。

> **为什么第 2 步不能省**：DSH 只加载 `dsh.profile.bundles` 里**显式列出**的包 —— 按
> `dsh-app-boot` 的说明，插件树是「按 `dsh.profile.bundles` 顺序把每个 bundle 的 patch
> 层叠到空条目表上」生成的。`dsh plugin add` 只是 pnpm 的转发，它把包装进
> `node_modules`，**不会**往 bundles 里加名字。少这一步，装了也不生效。

### 常用参数

```bash
node install.mjs --dry-run              # 只打印将做什么，不落盘
node install.mjs --profile myprofile    # 装进别的 profile（默认 web）
node install.mjs --dsh-home /path/.dsh  # 指定 DSH 主目录（多机/自定义 DSH_HOME）
node install.mjs --uninstall            # 卸载
```

安装器会先备份 profile 的 `package.json` 为 `package.json.bak-<时间戳>`；内容是幂等的，
重复运行不会重复写入，也不会堆积备份文件。

### 手工安装（不想跑脚本时）

编辑 `~/.dsh/profiles/web/package.json`，两处都加上：

```jsonc
{
  "dependencies": {
    "@dsh-external/dsh-pet-notepad": "link:/绝对路径/dsh-pet-notepad"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……原有条目保持不动，末尾追加：
        "@dsh-external/dsh-pet-notepad"
      ]
    }
  }
}
```

再建链接：`node_modules/@dsh-external/dsh-pet-notepad` → 仓库目录
（Windows 用 junction，macOS/Linux 用 symlink），最后重启 `dsh web`。

### 验证装好了

```bash
# 1. profile 里两处都在
node -e "const p=require(os.homedir()+'/.dsh/profiles/web/package.json');console.log(p.dependencies['@dsh-external/dsh-pet-notepad'], p.dsh.profile.bundles.includes('@dsh-external/dsh-pet-notepad'))"

# 2. Host 侧 API 有响应（需 dsh web 已启动）
curl http://127.0.0.1:3080/pet-notepad/api/state
# 期望：{"ok":true,"state":{"schemaVersion":1,...}}
```

---

## 用法

| 操作 | 结果 |
|---|---|
| 右键桌宠 | 打开/关闭悬浮记事本（贴宠物下方，随宠物拖动跟随） |
| 左键点悬浮窗外的任意处 | 关闭悬浮窗 |
| `Esc` | 关闭悬浮窗（输入法组合中的 Esc 交给输入法，不会误关） |
| 左侧栏「记事本」 | 打开中间整块记事本面板 |
| 输入 | 停止输入 600ms 自动保存；失焦、关闭悬浮窗时立即保存 |
| 「复制全部」 | 复制全文到剪贴板 |
| 「清空」 | 二次确认后清空 |

## 数据

```
$DSH_HOME/pet-notepad/notepad.json      # 缺省 ~/.dsh/pet-notepad/notepad.json
```

```jsonc
{
  "schemaVersion": 1,
  "revision": 3,          // 每次成功写入 +1，用于乐观并发
  "text": "……",           // 正文（上限 200000 字符）
  "updatedAt": 1790431159866
}
```

- **原子写**：先写 `*.tmp-<pid>-<ts>` 再 rename，不会出现半截文件。
- **损坏自愈**：文件不是合法 JSON / 顶层不是对象 / schemaVersion 不认识 → 改名留档为
  `notepad.json.corrupt-<ts>`，以空记事本启动，**绝不覆盖原字节**，UI 上会显示这条警告。
- **多标签页**：写请求带 `baseRevision`；服务端 revision 已前进时返回 `409` + 当前状态，
  客户端以本页内容重放一次。

### HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/pet-notepad/api/state` | 读当前状态 |
| `POST` | `/pet-notepad/api/set` | `{ text, baseRevision? }` 写正文 |

两道防护：`Host` 必须是 `127.0.0.1` / `localhost` / `::1`（防 DNS rebinding），
带 `Origin` 时必须与 `Host` 同源。正文上限 200000 字符，body 上限 1 MiB。

---

## 为什么它不会随桌宠更新失效

桌宠插件 `@linxin666/dsh-pet` 通常是 profile 的**版本依赖**（如 `"0.4.2"`），
`dsh` 升级它时会覆盖整个包目录 —— 任何写进桌宠源码的定制都会消失。

所以本插件**一行都不碰桌宠，也不 import 它**，只依赖它在 DOM 上暴露的一个标记：

```
[data-dsh-pet-root]     # 桌宠挂在 document.body 上的插件根节点
```

它同时承担两个职责：右键事件的命中区（`closest()` 判定），以及量精灵位置的查询范围。

位置测量三档降级：

1. root 内面积最大的 `[role="button"][aria-label]` —— 精灵本体，最准；
2. root 内面积最大的可见元素 —— 桌宠换了内部标记时的兜底；
3. 都量不到 → 悬浮窗贴右下角固定位，功能照常，只是不跟随。

两个实测踩过的坑（写在这里免得后人再踩）：

- 精灵是 **portal 进 root** 的，所以它是 `[data-pet-dock]` 那个 span 的**兄弟节点**，
  不是子节点 —— 从 dock 里 `querySelector` 一定找不到。
- `[data-pet-dock]` span 自身是 **0×0**（子元素全 `fixed` 定位，不参与它的布局），
  直接拿它的 `getBoundingClientRect()` 会得到全 0。

**最坏情况**：桌宠未来改了 root 标记 → 右键触发失效、位置不再跟随，但
**侧栏「记事本」入口、中间面板、数据全部照常可用**。

## 已知限制

- **右键菜单被占用**：在桌宠上右键不再弹出浏览器原生菜单（设计如此）。
- **与桌宠自身的 hover 面板可能重叠**：桌宠悬停时也会在下方弹面板，本插件 `z-index` 更高，
  打开时会盖住它。右键触发与 hover 通常不同时发生，但鼠标从宠物移到记事本上时可能看到面板闪现。
- **设置页卡片当前不渲染**：插件按 DSH 惯例注册了 `settings.plugin.item`，但某些 DSH 版本的
  「设置 → Web 插件」分区被其他插件接管、该 slot 未声明，注册会被静默拒绝（控制台 warning：
  `slot "web-ui.plugin.item" is not declared`）。代码保留，slot 恢复后自动生效，不影响任何核心功能。

## 目录结构

```
dsh-pet-notepad/
├── lib/
│   ├── index.js       # host 半区（ESM）：JSON 权威存储 + 同源 HTTP API
│   └── client.js      # client 半区：ModuleLoader bundle，注册 3 个 slot + 悬浮窗
├── install.mjs        # 安装器：写 profile 的 dependencies + bundles，建 node_modules 链接
├── cordis.patch.yml   # bundle patch：把插件行插进 profile 装配清单
└── package.json
```

## 开发

`lib/*.js` 就是最终产物，改完即生效，没有构建步骤。

本仓库作者另有一个 `sync-to-runtime.ps1`，用于把仓库源码同步到 DSH 运行副本
（`~/.dsh/plugins/<包名>`）—— 仅当他用「运行副本 + 源码仓库」双份布局时需要。
如果你直接用 `install.mjs` 把 profile 指向本仓库，就不需要它。

## License

[BSD-3-Clause](LICENSE)
