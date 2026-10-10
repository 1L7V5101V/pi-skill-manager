/**
 * skill-manager — 交互式管理哪些 skill 常驻 system prompt。
 *
 * 背景：pi 启动时把 skill 的 name+description 渲染进 `<available_skills>` XML 块
 * （dist/core/skills.js:275 formatSkillsForPrompt）。官方唯一的"不写文件"过滤点是
 * resource-loader 的 skillsOverride 构造参数（dist/core/resource-loader.js:178），
 * 扩展 API 拿不到；可达的钩子是 before_agent_start —— 每回合拿到已渲染好的
 * systemPrompt，可返回 { systemPrompt } 覆盖（dist/core/agent-session.js:915-939）。
 *
 * v2 重写要点（相对 v1）：
 * - 只有 /skilllist 一个命令，所有功能都收在里面
 * - 列表同时显示「启用」和「未启用」的 skill。skill 全量来自
 *   event.systemPromptOptions.skills —— 那是 pi 加载的完整列表，
 *   连 frontmatter 里 disable-model-invocation 的也在里面
 *   （formatSkillsForPrompt 才会把它们过滤掉，所以渲染后的 prompt 里看不到）
 * - 光标位置翻牌后保持不动：SettingsList 内部维护 selectedIndex，
 *   不像 ctx.ui.select 那样每次重建对话框、重置光标
 * - 每行右侧是 on/off，Enter 或空格翻牌；Esc 放弃不落盘
 *
 * 状态文件：<agentDir>/skill-manager.json
 */

import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = join(process.env.HOME || homedir(), ".pi", "agent");
const STATE_PATH = join(AGENT_DIR, "skill-manager.json");

/** null = 不干预，恢复 pi 默认（全部常驻） */
interface PersistedState {
	enabled: string[] | null;
}

function loadPersisted(): PersistedState {
	try {
		if (!existsSync(STATE_PATH)) return { enabled: null };
		const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as PersistedState;
		return { enabled: Array.isArray(raw.enabled) ? raw.enabled : null };
	} catch {
		return { enabled: null };
	}
}

let persisted: PersistedState = loadPersisted();

function savePersisted(): void {
	try {
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(STATE_PATH, JSON.stringify(persisted, null, 2));
	} catch {
		/* ignore */
	}
}

// ---- prompt 重写 ---------------------------------------------------------

/** 整块 skill 段落：从引导语到 </available_skills>。buildSystemPrompt 里它是 append 上去的。 */
const SKILL_BLOCK_RE = /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/;

/** XML 转义，与 dist/core/skills.js 的 escapeXml 保持一致的替换集合 */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 单个 <skill> 条目，缩进与 formatSkillsForPrompt 完全一致（2 空格）。
 *
 * SAFETY: 这里不复用官方的 formatSkillsForPrompt —— 它内部会
 * `.filter((s) => !s.disableModelInvocation)`（dist/core/skills.js:280），
 * 所以永远渲染不出 frontmatter 隐藏的 skill，而"让用户能打开隐藏 skill"
 * 正是本扩展的用途之一。因此只借用它的格式，不用它的过滤。
 */
function skillBlock(skill: Skill): string {
	return [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		`    <description>${escapeXml(skill.description)}</description>`,
		`    <location>${escapeXml(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

/** prompt 里原本没有 skill 段落时（所有 skill 都被 frontmatter 隐藏），要自己造一段引导语 */
function skillSectionIntro(useReadTool: boolean): string {
	return [
		"",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		useReadTool
				? "Use the read tool to load a skill's file when the task matches its description."
				: "Use bash to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
	].join("\n");
}

/**
 * 当前生效的常驻名单。返回 null 表示「不干预」（全常驻，等同 pi 默认）。
 * 只保留确实加载了的名字，避免删掉 skill 后配置文件里留下幽灵条目。
 */
function effectiveEnabled(allNames: string[]): Set<string> | null {
	if (persisted.enabled === null) return null;
	return new Set(persisted.enabled.filter((name) => allNames.includes(name)));
}

/**
 * 按当前配置重写 prompt 里的 skill 段落。
 *
 * 只替换 <skill> 条目，保留 pi 自己写的引导语（含 read/bash 措辞）原封不动。
 * 这样既能让被 frontmatter 隐藏的 skill"出现"，也不会和 pi 的格式漂移。
 */
export function rewriteSkills(
	systemPrompt: string,
	allSkills: Skill[],
	useReadTool = true,
): string {
	if (allSkills.length === 0) return systemPrompt;

	const enabled = effectiveEnabled(allSkills.map((s) => s.name));
	if (enabled === null) return systemPrompt;

	const kept = allSkills.filter((s) => enabled.has(s.name));
	const entries = kept.map(skillBlock).join("\n");

	const existing = SKILL_BLOCK_RE.exec(systemPrompt);
	if (existing) {
		// 沿用原本的引导语（到 <available_skills> 为止），只换条目
		const intro = existing[0].slice(0, existing[0].indexOf("<available_skills>"));
		const rebuilt = entries.length > 0
			? `${intro}<available_skills>\n${entries}\n</available_skills>`
			: "";
		if (rebuilt.length === 0) return systemPrompt.replace(SKILL_BLOCK_RE, "");
		return systemPrompt.replace(SKILL_BLOCK_RE, rebuilt);
	}

	// prompt 里本来没有任何 skill 段落（比如全被 frontmatter 隐藏了）→
	// 插到 "Current working directory" 之前，那正是 buildSystemPrompt 原本 append 的位置
	if (entries.length === 0) return systemPrompt;
	const section = `${skillSectionIntro(useReadTool)}<available_skills>\n${entries}\n</available_skills>`;
	return /\nCurrent working directory: /.test(systemPrompt)
		? systemPrompt.replace(/\nCurrent working directory: /, `\n${section}\nCurrent working directory: `)
		: `${systemPrompt}\n${section}`;
}

// ---- 列表构造 ------------------------------------------------------------

/**
 * 排序：启用的排前面，其次按名字。翻牌时最常用的浮在上面，且顺序可预测。
 * 名字相同的不会出现重复（loadSkills 已按 name 去重，skills.js:329）。
 */
function sortSkills(list: Skill[], enabled: Set<string> | null): Skill[] {
	return [...list].sort((a, b) => {
		if (enabled !== null) {
			const aOn = enabled.has(a.name) ? 0 : 1;
			const bOn = enabled.has(b.name) ? 0 : 1;
			if (aOn !== bOn) return aOn - bOn;
		}
		return a.name.localeCompare(b.name);
	});
}

function sourceLabel(skill: Skill): string {
	const scope = skill.sourceInfo?.scope;
	if (scope === "project") return "project";
	if (scope === "user") return "user";
	if (skill.sourceInfo?.source === "package") return "package";
	return "path";
}

function rowDescription(skill: Skill): string {
	const tags = [sourceLabel(skill)];
	if (skill.disableModelInvocation) tags.push("hidden by frontmatter");
	return `${tags.join(" · ")} — ${skill.description}`;
}

/** 粗略估算这段 skill 名单占的字符数，用来在表头给用户一个 token 直觉 */
function promptChars(skills: Skill[]): number {
	return skills.reduce((sum, s) => sum + s.name.length + s.description.length + 48, 0);
}

// ---- 唯一命令 ------------------------------------------------------------

interface SaveResult {
	enabled: string[];
}

export default function skillManagerPlugin(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (persisted.enabled === null) return;
		// systemPromptOptions.skills 是 pi 加载的全量列表，含 frontmatter 隐藏的
		const allSkills = event.systemPromptOptions.skills ?? [];
		const rewritten = rewriteSkills(event.systemPrompt, allSkills);
		if (rewritten !== event.systemPrompt) return { systemPrompt: rewritten };
	});

	pi.registerCommand("skilllist", {
		description: "Choose which skills stay in the system prompt (Enter/Space to toggle)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const allSkills = ctx.getSystemPromptOptions().skills ?? [];
			if (allSkills.length === 0) {
				ctx.ui.notify("No skills discovered.", "warning");
				return;
			}

			if (ctx.mode !== "tui") {
				const on = effectiveEnabled(allSkills.map((s) => s.name));
				ctx.ui.notify(
					`Skills: ${on === null ? `all ${allSkills.length} enabled (pi default)` : `${on.size}/${allSkills.length} enabled`}`,
					"info",
				);
				return;
			}

			// 打开 UI 期间的工作副本，Esc 放弃即不落盘
			let working: Set<string> = (() => {
				const on = effectiveEnabled(allSkills.map((s) => s.name));
				return new Set(on ?? allSkills.map((s) => s.name));
			})();

			let closing = false;

			const syncAllRows = (list: SettingsList) => {
				for (const skill of allSkills) {
					list.updateValue(skill.name, working.has(skill.name) ? "on" : "off");
				}
			};

			/** 关掉 submenu。必须推迟一帧：activateItem 先调 submenu 后给 this.submenuComponent 赋值。 */
			const deferCloseSubmenu = (closeSubmenu: (value: string | undefined) => void) => {
				setTimeout(() => closeSubmenu(undefined), 0);
			};

			const header = {
				render(width: number) {
					const on = allSkills.filter((s) => working.has(s.name));
					const line1 = `Skill manager — ${working.size}/${allSkills.length} in prompt`;
					const line2 = `  ~${promptChars(on)} chars of skill metadata · off rows cost 0`;
					return [truncate(line1, width), truncate(line2, width), ""];
				},
				invalidate() {},
			};

			const result = await ctx.ui.custom<SaveResult | undefined>(
				(tui, _theme, _keybindings, done) => {
					// closeDialog 必须在工厂内部定义：done 是 ctx.ui.custom 的回调，
					// 在这里才可见。submenu 里的 closeSubmenu 是另一个同名参数。
					const closeDialog = (value: SaveResult | undefined) => done(value);

					const skillItems: SettingItem[] = sortSkills(
						allSkills,
						effectiveEnabled(allSkills.map((s) => s.name)),
					).map((skill) => ({
						id: skill.name,
						label: skill.name,
						currentValue: working.has(skill.name) ? "on" : "off",
						values: ["on", "off"],
						description: rowDescription(skill),
					}));

								// 一次性动作行：Enter 执行后光标回到原处，不改变自己这一行的值。
								// submenu 的第二个参数是 SettingsList 的"收起子菜单"回调，与
								// ctx.ui.custom 的 done 同名但不同物，后者由 closeDialog 持有。
								const actionItems: SettingItem[] = [
						{
							id: "__all_on__",
							label: "▸ Enable all",
							currentValue: "run",
							submenu: (_v, closeSubmenu) => {
								working = new Set(allSkills.map((s) => s.name));
								syncAllRows(list);
								deferCloseSubmenu(closeSubmenu);
								tui.requestRender();
								return makeNoopComponent();
							},
						},
						{
							id: "__all_off__",
							label: "▸ Disable all",
							currentValue: "run",
							submenu: (_v, closeSubmenu) => {
								working = new Set();
								syncAllRows(list);
								deferCloseSubmenu(closeSubmenu);
								tui.requestRender();
								return makeNoopComponent();
							},
						},
						{
							id: "__invert__",
							label: "▸ Invert all",
							currentValue: "run",
							submenu: (_v, closeSubmenu) => {
								const next = new Set<string>();
								for (const s of allSkills) if (!working.has(s.name)) next.add(s.name);
								working = next;
								syncAllRows(list);
								deferCloseSubmenu(closeSubmenu);
								tui.requestRender();
								return makeNoopComponent();
							},
						},
						{
							id: "__save__",
							label: "▸ Save & close",
							currentValue: "run",
							submenu: (_v, closeSubmenu) => {
								// 先收起 submenu（selectedIndex 归位），再关 overlay，
								// 否则会渲染到已销毁的组件
								deferCloseSubmenu(closeSubmenu);
								closeDialog({ enabled: Array.from(working) });
								return makeNoopComponent();
							},
						},
								];

					const list: SettingsList = new SettingsList(
						[...skillItems, ...actionItems],
						Math.min(skillItems.length + actionItems.length + 5, 20),
						getSettingsListTheme(),
						(id) => {
							if (id.startsWith("__")) return;
							if (working.has(id)) working.delete(id);
							else working.add(id);
							// 翻别人的牌时同步一下表头计数就够了；updateValue 已由 SettingsList 自己做
						},
						() => {
							if (!closing) done(undefined);
						},
					);

					const container = new Container();
					container.addChild(header);
					container.addChild(list);

					return {
						render(width: number) {
							return container.render(width);
						},
						invalidate() {
							container.invalidate();
						},
						handleInput(data: string) {
							list.handleInput?.(data);
						},
					};
				},
			);

			// `closing` 只表示走到了 Save 行；Esc 走 done(undefined)，result 是 undefined
			if (result) {
				const next = result.enabled;
				// 全开时退化回 null，语义等同 pi 默认，配置文件也最干净
				persisted = next.length === allSkills.length ? { enabled: null } : { enabled: next };
				savePersisted();
				ctx.ui.notify(
					`Saved: ${next.length}/${allSkills.length} skills in prompt (~${promptChars(
						allSkills.filter((s) => next.includes(s.name)),
					)} chars).`,
					"info",
				);
			} else {
				ctx.ui.notify("Cancelled — no changes saved.", "info");
			}
		},
	});
}

// ---- helpers -------------------------------------------------------------

function truncate(text: string, width: number): string {
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * 立刻关掉 SettingsList 当前打开的 submenu。
 *
 * SAFETY: activateItem() 是 `this.submenuComponent = item.submenu(...)`，先调 submenu
 * 后赋值（settings-list.js:200-203）。所以在 submenu 回调里同步调用 closeSubmenu 会看到
 * this.submenuComponent 仍是 null，什么也不做 —— 动作行看起来"按了没反应"。
 * 用 setTimeout(0) 把 closeSubmenu 推迟到赋值之后，一帧内完成。
 */
function makeNoopComponent() {
	return { render: () => [""], invalidate() {}, handleInput() {} };
}
