# @dsh-external/dsh-pet-notepad

DSH Web GUI 的**桌宠伴生记事本**：右键宠物弹出一块悬浮记事本，挂在宠物正下方；左侧栏一个「记事本」入口，随时查看/编辑同一份内容。

- **单块纯文本**：没有卡片、没有标签、没有定时、不跑 agent。粘贴即存，就这么简单。
- **Host 权威**：内容存在 Host 侧的 JSON 文件里，浏览器只是视图。刷新、重开浏览器、换标签页，数据都在。
- **零构建**：`lib/*.js` 就是手写最终产物，没有 tsc/tsdown 步骤，不需要 DSH 源码 checkout。
- **抗 pet 更新**：见下文「为什么它不会随 pet 更新失效」。

## 目录结构

```
dsh-pet-notepad/
├── lib/
│   ├── index.js       # host 半区（ESM）：JSON 权威存储 + 同源 HTTP API
│   └── client.js      # client 半区：ModuleLoader bundle，注册 3 个 slot + 悬浮窗
├── cordis.patch.yml   # 永久装配用的 profile patch 片段
└── package.json
```

## 安装

**方式一：运行时注入（免重启，推荐）**

```
dev_inject_plugin {"dir": "C:/Users/xianw/.dsh/plugins/dsh-pet-notepad"}
```

注入成功后刷新 GUI：左侧栏出现「记事本」入口，右键宠物弹出悬浮记事本。

**方式二：永久装配到 profile（重启后仍生效）**

```bash
dsh plugin --profile web add link:C:/Users/xianw/.dsh/plugins/dsh-pet-notepad
```

或把 `cordis.patch.yml` 的内容并进 `~/.dsh/profiles/web/cordis.patch.yml` 后重启 `dsh web`。

**卸载**

```
dev_uninject_plugin {"match": "dsh-pet-notepad"}
```

> 注意 `match` 是子串匹配：`pet-notepad` 已经够独特，但仍建议传完整名 `dsh-pet-notepad`，避免误伤别人的插件。

## 用法

| 操作 | 结果 |
|---|---|
| 右键宠物 | 打开/关闭悬浮记事本（贴在宠物下方，随宠物拖动跟随） |
| 左键点悬浮窗外的任意处 | 关闭悬浮窗 |
| `Esc` | 关闭悬浮窗（输入法组合中的 Esc 交给输入法，不误关） |
| 左侧栏「记事本」 | 打开中间整块记事本面板 |
| 输入 | 停止输入 600ms 后自动保存；失焦、关闭悬浮窗时立即保存 |
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
  `notepad.json.corrupt-<ts>`，以空记事本启动，**绝不覆盖原字节**；UI 上会显示这条警告。
- **多标签页**：写请求带 `baseRevision`；服务端 revision 已前进时返回 `409` + 当前状态，
  客户端以本页内容重放一次。同源浏览器请求之外的写一律拒绝。

### HTTP API（同源，仅回环）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/pet-notepad/api/state` | 读当前状态 |
| `POST` | `/pet-notepad/api/set` | `{ text, baseRevision? }` 写正文 |

两道防护：`Host` 必须是 `127.0.0.1` / `localhost` / `::1`（防 DNS rebinding），
带 `Origin` 时必须与 `Host` 同源。正文上限 200000 字符，body 上限 1 MiB。

## 为什么它不会随 pet 更新失效

`dsh-pet` 是 profile 的**版本依赖**（`"@linxin666/dsh-pet": "0.4.2"`），
`dsh` 一升级 pet，整个包目录被覆盖 —— 任何写进 pet 源码的改动都会消失。

所以本插件**一行都不碰 pet，也不 import 它**，只依赖 pet 在 DOM 上暴露的一个标记：

```
[data-dsh-pet-root]     # pet 挂在 document.body 上的插件根节点
```

它同时承担两个职责：右键事件的命中区（`closest()` 判定），以及量精灵位置的查询范围。

位置测量三档降级（`petSpriteRect`）：

1. root 内面积最大的 `[role="button"][aria-label]` —— 精灵本体，最准
2. root 内面积最大的可见元素 —— pet 换了内部标记时的兜底
3. 都量不到 → 悬浮窗贴右下角固定位，功能照常，只是不跟随

两个实测踩过的坑（写在这里免得后人再踩）：

- 精灵是 **portal 进 root** 的，所以它是 `[data-pet-dock]` 那个 span 的**兄弟节点**，
  不是子节点 —— 从 dock 里 `querySelector` 一定找不到。
- `[data-pet-dock]` span 自身是 **0×0**（子元素全 `fixed` 定位，不参与它的布局），
  直接拿它的 `getBoundingClientRect()` 会得到全 0。

最坏情况：pet 未来改了 root 标记 → 右键触发失效、位置不再跟随，但**侧栏「记事本」入口
和中间面板照常可用，数据也不会丢**。

## 已知限制

- **`settings.plugin.item` 卡片当前不渲染**。本插件按 DSH 插件惯例注册了设置页卡片，
  但当前 DSH 版本的「设置 → Web 插件」分区已被 `@linxin666/dsh-liangshen` 接管，
  该 slot 未被声明，注册被静默拒绝（控制台 warning：`slot "web-ui.plugin.item" is not
  declared`）。**同生态的 `@dsh-external/dsh-sticky-notes` 卡片同样不渲染**，属既有现象。
  代码保留，未来 DSH 恢复该 slot 时自动生效；不影响任何核心功能。
- **右键菜单被本插件占用**：在宠物上右键不再弹出浏览器原生菜单（这是设计如此）。
- **与 pet 自身的 hover 面板可能重叠**：pet 在鼠标悬停时也会在宠物下方弹面板
  （`.panel`，`top: 100%`）。悬浮记事本 `z-index` 更高，打开时会盖住它。
  右键触发与 hover 触发通常不同时发生，但把鼠标从宠物移到记事本上时可能看到 pet 面板闪现。
