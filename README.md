# pi-skill-manager

一个 [pi](https://github.com/earendil-works/pi) 扩展：用交互式列表管理哪些 skill 常驻 `system prompt`。

## 解决什么问题

pi 启动时会把**所有** skill 的 `name + description` 渲染成 `<available_skills>` XML 块塞进 system prompt。93 个 skill 目录、63 个唯一名字时，这段元数据约 13768 字符（≈3900 token），每一回合都要重新付费，而其中大部分 skill 一年用不到一次。

官方提供的不常驻手段只有一个：在 `SKILL.md` 的 frontmatter 里写

```yaml
disable-model-invocation: true
```

这要求逐个改文件、改完还得记得改回来、也无法同时看到"启用 / 未启用"的全貌。
本扩展把这件事变成一个命令。

## 功能

- `/skilllist` 一个命令包含全部功能：列出**所有** skill、逐个开关、批量操作、保存
- 列表同时显示启用和未启用的 skill；顺序固定：启用的在前（字母序），未启用的在后（字母序）
- 翻牌后光标**停留在原行**——不会像 `ctx.ui.select` 那样每次重建对话框、光标跳回第一项
- 批量动作行：`Enable all` / `Disable all` / `Invert all` / `Save & close`
- `Esc` 放弃修改，配置文件一字不动；只有 `Save & close` 才落盘
- 表头实时显示 `n/N in prompt` 和这段元数据的字符数，给你 token 直觉
- 非 TUI 模式（`--print` / rpc / json）下调用 `/skilllist` 只打一行状态，不弹 UI
- 名单存 `~/.pi/agent/skill-manager.json`，**全局生效**（所有项目、所有会话共用一个名单）

## 安装

把 `skill-manager.ts` 放到 pi 的扩展目录：

```text
~/.pi/agent/extensions/skill-manager.ts        # 全局
.pi/extensions/skill-manager.ts                # 项目级
```

然后 `/reload`，或重启 pi。

无第三方依赖，只用 pi 自己导出的 `@earendil-works/pi-tui` 和 `@mariozechner/pi-coding-agent`。

## 用法

```
/skilllist
```

| 按键 | 作用 |
| --- | --- |
| `↑` `↓` / `j` `k` | 移动光标（到头循环） |
| `Enter` / `Space` | 当前行开关；动作行则执行该动作 |
| 输入字符 | 过滤（`SettingsList` 自带的模糊搜索） |
| `Esc` | 放弃并关闭，不写文件 |

走到 `▸ Save & close` 按 `Enter` 保存。

## 状态文件

`~/.pi/agent/skill-manager.json`：

```json
{ "enabled": ["codebase-design", "find-skills", "git-commit"] }
```

- `enabled` 是**白名单**：只有列出的 skill 会出现在 system prompt 里，其余全部被移除
- `enabled: null`（或删掉文件）= 不干预，恢复 pi 默认的"全部常驻"
- 全选时保存会自动写成 `null`，保持配置最干净
- 文件里失效的名字（skill 已删）会被自动忽略，不会留下幽灵条目

名单按 **skill 名字**匹配，不按路径。所以同一个 skill 在多个 root 下有副本时，会一起被开关。

## 实现要点

三个不那么明显的坑，改这个文件前最好先知道：

1. **不能复用官方的 `formatSkillsForPrompt`。**
   `dist/core/skills.js:275` 那个函数第一行就是 `!s.disableModelInvocation` 过滤，所以它**永远**渲染不出被 frontmatter 隐藏的 skill。本扩展自己按官方格式拼条目（2 空格缩进的 `<skill>` 块），并且只替换 `<skill>` 条目、保留 pi 原写的引导语，这样 pi 改文案也不会漂移。

2. **改 `options.skills` 是无效的。**
   `_baseSystemPromptOptions.skills` 虽然是活对象，但 `_rebuildSystemPrompt` 只在 `dist/core/agent-session.js:671`、`:1943` 和 `resources_discover` 时被调用。唯一可靠的杠杆是在 `before_agent_start` 里返回 `{ systemPrompt }`（`agent-session.js:915-939`），它按扩展逐个链式生效，并在每次运行结束后于 `:781` 重置。

3. **在 `submenu` 回调里不能同步调 `closeSubmenu`。**
   `SettingsList.activateItem()` 是 `this.submenuComponent = item.submenu(...)` —— 先调 `submenu`，后赋值。所以同步调用时 `this.submenuComponent` 还是 `null`，`closeSubmenu` 直接 return，动作行看起来"按了没反应"。必须 `setTimeout(..., 0)` 推迟一帧。见本文件的 `deferCloseSubmenu`。

## 许可

MIT
