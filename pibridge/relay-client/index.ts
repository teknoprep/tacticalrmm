/**
 * rmm-relay - use your RMM's agent groups (IT, Coding, ...) from ANY pi.
 *
 * Model calls go to the RMM's pi relay (the bridge), which runs them with the RMM's provider
 * keys and group config and records every call in the RMM spend ledger. Your machine needs
 * no provider API keys - only an RMM username and a relay key.
 *
 * Install:   curl -fsSL https://api.blueuc.com/pi/relay/v1/client/install.sh | bash
 *            (Windows PowerShell: irm https://api.blueuc.com/pi/relay/v1/client/install.ps1 | iex)
 * Sign in:   /rmm-login            one key signs you in to every group it reaches
 *            the key + username are stored in ~/.pi/agent/rmm-relay.json (mode 600)
 * Use:       /group coding         this chat now runs on the Coding group's orchestrator
 *            the model can call `delegate` to hand work to the group's specialists
 *            (scout, coder, reviewer, ...), each a separate pi process on its own model.
 * Status:    /rmm-status           who you are, groups, roles, today's / this month's spend
 *
 * Models:    rmm/<group>           the group's orchestrator      e.g. rmm/coding
 *            rmm/<group>/<role>    one specialist                e.g. rmm/coding/coder
 *
 * Env overrides (CI / servers): PI_RMM_RELAY_URL, PI_RMM_RELAY_USER, PI_RMM_RELAY_KEY.
 * Server side: /opt/pi-trmm-bridge/src/relay.js, docs/PI-RELAY.md.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT_VERSION = "1.2.2";
const PROTOCOL = 2;

/** Is `a` a newer dotted version than `b`? Used to tell the user when the relay is serving a
 * newer extension than the one running here, so "re-run the installer" is discoverable. */
function isNewer(a: string, b: string): boolean {
	const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
	const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) return d > 0;
	}
	return false;
}
// ---------------------------------------------------------------- self-update (1.2.2)
// OFFER THE UPDATE AT STARTUP (owner, 2026-09-30). /rmm-status used to print curl / irm
// commands to paste; now pi asks "Update now?" when it starts and does it itself. Only the
// extension file is replaced (a backup is kept next to it) and the sign-in is untouched.
// The installer is still the way to get a first copy, and to repair a broken setup.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const EXT_FILE = path.join(AGENT_DIR, "extensions", "rmm-relay", "index.ts");
const versionOf = (src: string) => (src.match(/^const CLIENT_VERSION = "([^"]+)"/m) || [])[1] || "";

async function servedClientVersion(url: string): Promise<string> {
	const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
	const h: any = await r.json();
	return String(h?.client_version || "");
}

/** Replace this extension with the relay's copy. Returns the version now on disk. */
async function installUpdate(url: string, want: string): Promise<string> {
	// Only the file this copy was installed as - never a dev copy loaded with -e.
	let current = "";
	try { current = fs.readFileSync(EXT_FILE, "utf8"); } catch { throw new Error(`not installed at ${EXT_FILE} - use the installer`); }
	if (versionOf(current) !== CLIENT_VERSION) throw new Error(`${EXT_FILE} is not the copy running now - use the installer`);
	const r = await fetch(`${url}/client/index.ts`, { signal: AbortSignal.timeout(20000) });
	if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
	const src = await r.text();
	const got = versionOf(src);
	// Sanity: the file is what /health announced, newer than ours, and looks like this extension.
	if (!got || got !== want || !isNewer(got, CLIENT_VERSION) || !/^export default (async )?function/m.test(src)) {
		throw new Error(`downloaded file is not rmm-relay v${want} (got "${got || "?"}")`);
	}
	fs.copyFileSync(EXT_FILE, `${EXT_FILE}.bak-${CLIENT_VERSION}`);
	const tmp = `${EXT_FILE}.tmp`;
	fs.writeFileSync(tmp, src);
	fs.renameSync(tmp, EXT_FILE);
	return got;
}

const PROVIDER = "rmm";
const API = "rmm-relay";
const DEFAULT_URL = "https://api.blueuc.com/pi/relay/v1";
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "rmm-relay.json");
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const ROLE_TOOLS: Record<string, string[]> = {
	coder: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};
const MAX_DELEGATE_OUTPUT = 50_000;

type Account = { username: string; key: string };
type ModelInfo = {
	provider: string;
	model_id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap: Record<string, string | null> | null;
};
type RoleInfo = {
	role: string;
	provider: string;
	model_id: string;
	display_name: string;
	thinking_level: string;
	definition: string;
	model: ModelInfo | null;
};
type GroupInfo = { id: number; name: string; slug: string; kind: string; description: string; roles: RoleInfo[] };
type UserInfo = { username: string; email: string; display: string };
type KeyInfo = {
	key_id: string;
	label: string;
	expires_at: string | null;
	daily_budget_usd: number | null;
	monthly_budget_usd: number | null;
	spend: { today_usd: number; month_usd: number };
};
type Whoami = { protocol: number; user: UserInfo; key: KeyInfo; groups: GroupInfo[] };
type Access = { account: Account; user: UserInfo; key: KeyInfo; group: GroupInfo };
type CacheEntry = { user: UserInfo; key: KeyInfo; group: GroupInfo; fetched_at?: number; sig?: string };
type Config = { url: string; accounts: Account[]; cache?: Record<string, CacheEntry> };

// ---------------------------------------------------------------- config
function loadConfig(): Config {
	let cfg: Config = { url: DEFAULT_URL, accounts: [] };
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		cfg = { url: raw.url || DEFAULT_URL, accounts: Array.isArray(raw.accounts) ? raw.accounts : [], cache: raw.cache || {} };
	} catch {
		/* no config yet */
	}
	if (process.env.PI_RMM_RELAY_URL) cfg.url = process.env.PI_RMM_RELAY_URL;
	if (process.env.PI_RMM_RELAY_USER && process.env.PI_RMM_RELAY_KEY) {
		cfg.accounts = [{ username: process.env.PI_RMM_RELAY_USER, key: process.env.PI_RMM_RELAY_KEY }, ...cfg.accounts];
	}
	cfg.url = cfg.url.replace(/\/+$/, "");
	return cfg;
}

function saveConfig(cfg: Config) {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	const tmp = CONFIG_PATH + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, CONFIG_PATH);
	try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* windows */ }
}

// THE FILE ON DISK IS THE TRUTH FOR ACCOUNTS (1.2.1, 2026-09-30). The config used to be read
// once at startup and then written back WHOLE on every refresh - so a key fixed while pi was
// running (by /rmm-login in another window, the installer, or an admin) was silently put back
// to the old one within minutes. On rmm.blueuc.com a dead key was restored this way and the
// relay refused this computer 83 times in a day. Refreshes now adopt the accounts on disk and
// write only the cache; the accounts are changed only by /rmm-login and /rmm-logout.
const acctSig = (list: Account[]) => list.map((x) => `${x.username}:${x.key}`).join("|");
function syncAccountsFromDisk(): boolean {
	const disk = loadConfig();
	if (acctSig(disk.accounts) === acctSig(config.accounts) && disk.url === config.url) return false;
	config.accounts = disk.accounts;
	config.url = disk.url;
	return true;
}
function saveCacheOnly() {
	let disk: any = null;
	try { disk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { disk = null; }
	saveConfig({
		url: disk?.url || config.url,
		accounts: Array.isArray(disk?.accounts) ? disk.accounts : config.accounts,
		cache: config.cache,
	});
}

const basic = (a: Account) => "Basic " + Buffer.from(`${a.username}:${a.key}`).toString("base64");

async function fetchWhoami(url: string, a: Account, timeoutMs = 10000): Promise<Whoami> {
	const res = await fetch(`${url}/whoami`, { headers: { Authorization: basic(a) }, signal: AbortSignal.timeout(timeoutMs) });
	const text = await res.text();
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not json */ }
	if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
	if (data?.protocol !== PROTOCOL) {
		throw new Error(`the relay speaks protocol ${data?.protocol} but this extension speaks ${PROTOCOL} - update it: re-run the install command (see /rmm-status)`);
	}
	if (!Array.isArray(data.groups) || !data.groups.length) throw new Error("this key reaches no agent group - ask your RMM admin");
	return data as Whoami;
}

// ---------------------------------------------------------------- state
let config: Config = loadConfig();
const groups = new Map<string, Access>(); // group slug -> access
let currentSlug: string | undefined; // last group used in this session

function modelIdFor(slug: string, role: string) {
	return role === "orchestrator" ? slug : `${slug}/${role}`;
}
function parseModelId(id: string): { slug: string; role: string } {
	const [slug, role] = String(id).split("/");
	return { slug, role: role || "orchestrator" };
}
function roleOf(a: Access, role: string): RoleInfo | undefined {
	return a.group.roles.find((r) => r.role === role);
}

// ---------------------------------------------------------------- the stream (pi provider)
function errorMessageFor(model: any, message: string, aborted = false) {
	return {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: (aborted ? "aborted" : "error") as "aborted" | "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function relayStream(model: any, context: any, options?: any) {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const { slug, role } = parseModelId(model.id);
		const access = groups.get(slug);
		let started = false;
		const fail = (msg: string) => {
			const aborted = !!options?.signal?.aborted;
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: errorMessageFor(model, msg, aborted) } as any);
			stream.end();
		};
		if (!access) return fail(`RMM relay: not signed in for group '${slug}'. Run /rmm-login.`);
		currentSlug = slug;
		try {
			const res = await fetch(`${config.url}/stream`, {
				method: "POST",
				headers: { Authorization: basic(access.account), "Content-Type": "application/json", "X-Relay-Client": `rmm-relay/${CLIENT_VERSION}` },
				body: JSON.stringify({
					protocol: PROTOCOL,
					group: slug,
					role,
					context: { messages: context.messages },
					options: {
						reasoning: options?.reasoning,
						maxTokens: options?.maxTokens,
						temperature: options?.temperature,
						cacheRetention: options?.cacheRetention,
						toolChoice: options?.toolChoice,
						sessionId: options?.sessionId,
					},
				}),
				signal: options?.signal,
			});
			if (!res.ok || !res.body) {
				let err = `HTTP ${res.status}`;
				try { err = (await res.json())?.error || err; } catch { /* keep */ }
				// Budget/permission refusals must NOT look like rate limits, or pi retries them forever.
				if (/budget/i.test(err)) return fail(`RMM relay refused: ${err}`);
				return fail(`RMM relay error (${res.status}): ${err}`);
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			let partial: any = null;
			let finished = false;
			const onEvent = (ev: any) => {
				if (!ev || typeof ev !== "object") return;
				if (ev.type === "relay_start" || ev.type === "relay_ping" || ev.type === "relay_end") return;
				if (ev.type === "relay_error") { finished = true; fail(`RMM relay: ${ev.error}`); return; }
				if (ev.partial) partial = ev.partial;
				// The relay drops `partial` from text/thinking deltas; rebuild it here.
				if ((ev.type === "text_delta" || ev.type === "thinking_delta") && partial) {
					const block = partial.content?.[ev.contentIndex];
					if (block) {
						if (ev.type === "text_delta") block.text = (block.text || "") + ev.delta;
						else block.thinking = (block.thinking || "") + ev.delta;
					}
					ev.partial = partial;
				}
				if (ev.type === "start") started = true;
				stream.push(ev);
				if (ev.type === "done" || ev.type === "error") { finished = true; stream.end(); }
			};
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					try { onEvent(JSON.parse(line)); } catch { /* skip a torn line */ }
					if (finished) return;
				}
			}
			if (buf.trim()) { try { onEvent(JSON.parse(buf)); } catch { /* ignore */ } }
			if (!finished) fail(started ? "RMM relay: stream ended before the model finished" : "RMM relay: empty response");
		} catch (e: any) {
			fail(options?.signal?.aborted ? "Request aborted" : `RMM relay unreachable: ${e?.message || e}`);
		}
	})();
	return stream;
}

// ---------------------------------------------------------------- provider registration
function registerModels(pi: ExtensionAPI) {
	const models: any[] = [];
	for (const [slug, a] of groups) {
		for (const r of a.group.roles) {
			if (!r.model) continue;
			const m = r.model;
			models.push({
				id: modelIdFor(slug, r.role),
				name: r.role === "orchestrator"
					? `RMM ${a.group.name} (${m.name})`
					: `RMM ${a.group.name} · ${r.role} (${m.name})`,
				reasoning: m.reasoning,
				input: m.input,
				cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			});
		}
	}
	if (!models.length) {
		try { pi.unregisterProvider(PROVIDER); } catch { /* not registered */ }
		return;
	}
	pi.registerProvider(PROVIDER, {
		name: "RMM relay",
		baseUrl: config.url,
		apiKey: "relay", // real auth is per group, added by relayStream
		api: API as any,
		streamSimple: relayStream as any,
		models,
	});
}

/** Store every group a key reaches. Keys are shared: the same account covers all of them. */
/**
 * A group's shape, for spotting an admin's edit: which roles exist, on which models, at which
 * thinking level. The ORDER of `roles` is irrelevant (it comes from the group's member ids), so
 * it is sorted - otherwise a harmless reorder would look like a change.
 */
function rosterSig(g: GroupInfo): string {
	return JSON.stringify((g.roles || []).map((r) => [r.role, r.provider, r.model_id, r.thinking_level]).sort());
}

/** "coder: DeepSeek-V4-Pro -> DeepSeek V4.1 Flash; planner thinking medium -> high" */
function describeChange(before: GroupInfo, after: GroupInfo): string {
	const old = new Map((before.roles || []).map((r) => [r.role, r]));
	const now = new Map((after.roles || []).map((r) => [r.role, r]));
	const bits: string[] = [];
	for (const [role, r] of now) {
		const b = old.get(role);
		if (!b) { bits.push(`${role} added (${r.display_name})`); continue; }
		if (b.model_id !== r.model_id || b.provider !== r.provider) bits.push(`${role}: ${b.display_name} → ${r.display_name}`);
		else if ((b.thinking_level || "") !== (r.thinking_level || "")) bits.push(`${role} thinking ${b.thinking_level || "default"} → ${r.thinking_level || "default"}`);
	}
	for (const role of old.keys()) if (!now.has(role)) bits.push(`${role} removed`);
	return bits.join("; ");
}

function applyWhoami(account: Account, who: Whoami) {
	config.cache = config.cache || {};
	for (const g of who.groups) {
		const prev = config.cache[g.slug];
		const sig = rosterSig(g);
		// The baseline is the cached roster, or - for a cache written before signatures existed
		// (any client upgraded from 1.1.0) - the roster this process is actually holding in memory.
		// Without that fallback the FIRST refresh after an upgrade had nothing to compare against
		// and an admin's edit went unnoticed (found by testing this feature, 2026-09-27).
		const prevGroup = prev?.group || groups.get(g.slug)?.group;
		const prevSig = prev?.sig || (prevGroup ? rosterSig(prevGroup) : undefined);
		// AN ADMIN EDITED THIS GROUP. Say so, once, in the chat: the roster in this conversation
		// was about to go stale silently, and the model would keep delegating to a role that had
		// moved to another model (or vanished).
		if (prevSig && prevSig !== sig && prevGroup) {
			const what = describeChange(prevGroup, g);
			if (what) pendingNotes.push(`RMM agent group "${g.name}" was changed in the RMM: ${what}. That applies from now on.`);
		}
		groups.set(g.slug, { account, user: who.user, key: who.key, group: g });
		config.cache[g.slug] = { user: who.user, key: who.key, group: g, fetched_at: Date.now(), sig };
	}
}

function loadFromCache() {
	for (const a of config.accounts) {
		for (const [slug, c] of Object.entries(config.cache || {})) {
			if (c?.key?.key_id && a.key.includes(`_${c.key.key_id}_`)) groups.set(slug, { account: a, user: c.user, key: c.key, group: c.group });
		}
	}
}

let offeredUpdate = false;

// Notes waiting to be shown once (an admin's edit to a group this chat is using).
let pendingNotes: string[] = [];

async function refreshAll(): Promise<string[]> {
	const problems: string[] = [];
	// Someone changed the key on disk since we loaded it: use theirs, and rebuild the groups.
	if (syncAccountsFromDisk()) groups.clear();
	await Promise.all(config.accounts.map(async (a) => {
		try { applyWhoami(a, await fetchWhoami(config.url, a)); }
		catch (e: any) { problems.push(`${a.username} (${a.key.slice(0, 17)}…): ${e?.message || e}`); }
	}));
	try { if (!process.env.PI_RMM_RELAY_KEY) saveCacheOnly(); } catch { /* read-only home */ }
	return problems;
}

/**
 * Refresh only when the roster we hold is older than `maxAgeMs`, and hand back what changed.
 *
 * The drain happens EVEN WHEN THE CACHE IS FRESH: the extension's own startup refresh (and
 * /rmm-status) can queue a change note while nothing is running, and the next turn is the only
 * chance to say it. Returning early on a fresh cache swallowed exactly that note the first time
 * this was tested (2026-09-27).
 */
async function refreshIfStale(maxAgeMs: number): Promise<string[]> {
	if (!config.accounts.length) return [];
	const ages = Object.values(config.cache || {}).map((c) => Date.now() - Number(c?.fetched_at || 0));
	const covered = Object.keys(config.cache || {}).length;
	if (!covered || ages.some((a) => a >= maxAgeMs)) await refreshAll();
	const out = pendingNotes;
	pendingNotes = [];      // delivered once; a note arriving while nothing runs waits here
	return out;
}

// ---------------------------------------------------------------- delegate
function currentGroup(ctx: ExtensionContext, explicit?: string): string | undefined {
	if (explicit) return explicit;
	const m = ctx.model as any;
	if (m?.provider === PROVIDER) return parseModelId(m.id).slug;
	if (currentSlug && groups.has(currentSlug)) return currentSlug;
	return groups.size === 1 ? [...groups.keys()][0] : undefined;
}

function getPiInvocation(args: string[]) {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function runSpecialist(ctx: ExtensionContext, slug: string, r: RoleInfo, task: string, signal: AbortSignal | undefined, onUpdate: any) {
	const tools = ROLE_TOOLS[r.role] || READ_ONLY_TOOLS;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rmm-delegate-"));
	const promptFile = path.join(dir, "role.md");
	fs.writeFileSync(promptFile,
		`You are the ${r.role.toUpperCase()} specialist of the RMM agent group "${slug}". The orchestrator delegated ONE task to you. ` +
		`You cannot see its conversation - everything you need is in the task. Answer the task and stop; your final message is returned to the orchestrator verbatim.\n\n` +
		(r.definition ? `YOUR ROLE:\n${r.definition}\n` : ""), { mode: 0o600 });
	const args = ["--mode", "json", "-p", "--no-session", "--model", `${PROVIDER}/${modelIdFor(slug, r.role)}`,
		"--tools", tools.join(","), "--append-system-prompt", promptFile];
	if (r.thinking_level) args.push("--thinking", r.thinking_level);
	args.push(`Task: ${task}`);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let finalText = "";
	let stderr = "";
	let turns = 0;
	let lastError = "";
	try {
		const code = await new Promise<number>((resolve) => {
			const inv = getPiInvocation(args);
			const proc = spawn(inv.command, inv.args, { cwd: ctx.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buf = "";
			const line = (l: string) => {
				if (!l.trim()) return;
				let ev: any;
				try { ev = JSON.parse(l); } catch { return; }
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					const m = ev.message;
					turns++;
					const u = m.usage || {};
					usage.input += u.input || 0; usage.output += u.output || 0;
					usage.cacheRead += u.cacheRead || 0; usage.cacheWrite += u.cacheWrite || 0;
					usage.totalTokens += u.totalTokens || 0;
					for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) (usage.cost as any)[k] += u.cost?.[k] || 0;
					const text = (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
					if (text) finalText = text;
					if (m.errorMessage) lastError = m.errorMessage;
					onUpdate?.({ content: [{ type: "text", text: `${r.role} (${r.display_name}): turn ${turns}, $${usage.cost.total.toFixed(4)}` }], details: {} });
				}
			};
			proc.stdout.on("data", (d) => { buf += d.toString(); const ls = buf.split("\n"); buf = ls.pop() || ""; ls.forEach(line); });
			proc.stderr.on("data", (d) => { stderr += d.toString(); });
			proc.on("close", (c) => { if (buf.trim()) line(buf); resolve(c ?? 0); });
			proc.on("error", (e) => { stderr += String(e); resolve(1); });
			if (signal) {
				const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
				if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
			}
		});
		if (signal?.aborted) throw new Error("delegate aborted");
		if (!finalText) throw new Error(`${r.role} returned nothing (exit ${code}). ${lastError || stderr.slice(-800)}`);
		const out = finalText.length > MAX_DELEGATE_OUTPUT ? finalText.slice(0, MAX_DELEGATE_OUTPUT) + "\n…(truncated)" : finalText;
		return {
			content: [{ type: "text" as const, text: `[${r.role} · ${r.display_name} · ${turns} turn(s) · $${usage.cost.total.toFixed(4)}]\n${out}` }],
			details: { role: r.role, model: `${r.provider}/${r.model_id}`, turns, cost: usage.cost.total },
			usage,
		};
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

function registerDelegate(pi: ExtensionAPI) {
	const lines: string[] = [];
	for (const [slug, a] of groups) {
		const roles = a.group.roles.filter((r) => r.role !== "orchestrator" && r.role !== "judge" && r.model);
		if (roles.length) lines.push(`  ${slug}: ${roles.map((r) => `${r.role} (${r.display_name})`).join(", ")}`);
	}
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Hand ONE narrow, self-contained job to a specialist of an RMM agent group. The specialist is a separate " +
			"pi with a fresh context (it cannot see this chat) running on its own model, so this keeps this conversation small " +
			"and puts expensive models only where they are needed. scout/files/grep/planner/reviewer/summarizer/researcher/operator " +
			"are READ-ONLY (read, grep, find, ls); coder can also edit, write and run bash in the current directory. " +
			"Give file paths, names and the exact outcome you want. Specialists by group:\n" + (lines.join("\n") || "  (none - run /rmm-login)"),
		promptSnippet: "Delegate a narrow task to a specialist of the RMM agent group (scout, coder, reviewer, ...)",
		promptGuidelines: [
			"Use delegate for recon, bulk reading and reviews instead of reading many files into this conversation yourself.",
			"Use delegate with role coder for multi-file code changes; review what it reports before continuing.",
		],
		parameters: Type.Object({
			role: Type.String({ description: "Specialist role, e.g. scout, grep, files, planner, coder, reviewer, summarizer" }),
			task: Type.String({ description: "Self-contained instructions. The specialist cannot see this chat." }),
			group: Type.Optional(Type.String({ description: "Agent group slug. Default: the group of the current model." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const slug = currentGroup(ctx, params.group);
			if (!slug || !groups.has(slug)) throw new Error(`No RMM group selected. Use /group <${[...groups.keys()].join("|") || "slug"}> first.`);
			const a = groups.get(slug)!;
			const role = String(params.role || "").trim().toLowerCase();
			if (role === "orchestrator") throw new Error("You are the orchestrator - do not delegate to yourself.");
			if (role === "judge") throw new Error("The judge is not a delegate target.");
			const r = roleOf(a, role);
			if (!r || !r.model) throw new Error(`Group '${slug}' has no role '${role}'. Roles: ${a.group.roles.map((x) => x.role).filter((x) => x !== "orchestrator").join(", ")}`);
			return await runSpecialist(ctx, slug, r, String(params.task || ""), signal, onUpdate);
		},
	});
}

// ---------------------------------------------------------------- extension entry
export default async function (pi: ExtensionAPI) {
	config = loadConfig();
	loadFromCache();
	// Ask the relay at startup when the cache is missing or stale, so a group added in the RMM
	// shows up here (and `pi --list-models` is right) without starting a chat first. A failure
	// is not fatal: the cached groups are still registered below.
	const STALE_MS = 5 * 60_000;
	const stale = Object.values(config.cache || {}).some((c) => !c?.fetched_at || Date.now() - c.fetched_at > STALE_MS);
	if (config.accounts.length && (groups.size === 0 || stale)) await refreshAll();
	registerModels(pi);
	registerDelegate(pi);

	// AN ADMIN EDITS A GROUP, AN OPEN CHAT FINDS OUT (owner, 2026-09-27). The roster used to be
	// fetched only at session start / /rmm-login / /rmm-status, so a running chat kept delegating
	// to a role that had moved to another model (or had been removed) until the next session. This
	// re-reads it before a turn when what we hold is older than a minute - one HTTP call per
	// minute at most - and, when something actually changed, says so in the chat so the model
	// stops using the old roster. Failures are ignored: the relay being unreachable must not stop
	// someone working, and the cached roster still works.
	pi.on("before_agent_start", async () => {
		if (!config.accounts.length) return;
		let notes: string[] = [];
		try { notes = await refreshIfStale(60_000); } catch (e) { if (process.env.PI_RMM_DEBUG) console.error("[rmm-relay] refresh failed:", e); }
		if (process.env.PI_RMM_DEBUG) console.error("[rmm-relay] roster notes:", JSON.stringify(notes));
		if (!notes.length) return;
		registerModels(pi);
		registerDelegate(pi);
		return { message: { customType: "rmm-relay", content: notes.join("\n"), display: true } };
	});

	pi.on("session_start", async (_e, ctx) => {
		if (!config.accounts.length) return;
		const problems = await refreshAll();
		registerModels(pi);
		registerDelegate(pi);
		if (pendingNotes.length && ctx.hasUI) {
			ctx.ui.notify(pendingNotes.join("\n"), "info");
			pendingNotes = [];
		}
		if (problems.length && ctx.hasUI) ctx.ui.notify(`RMM relay: ${problems.join("; ")}`, "warning");
		// Offer an update - once per start, never in print/non-interactive mode, and after the
		// startup settles (not awaited, so a slow relay or an unanswered prompt blocks nothing).
		if (ctx.hasUI && !offeredUpdate && process.env.PI_RMM_RELAY_NO_AUTOUPDATE !== "1") {
			offeredUpdate = true;
			setTimeout(async () => {
				try {
					const served = await servedClientVersion(config.url);
					if (!served || !isNewer(served, CLIENT_VERSION)) return;
					const yes = await ctx.ui.confirm(
						`RMM relay update: v${CLIENT_VERSION} -> v${served}`,
						"Install it now? Your sign-in is kept. Type /reload afterwards (or restart pi) to use it.",
					);
					if (!yes) { ctx.ui.notify("Skipped. Run /rmm-update whenever you like.", "info"); return; }
					const v = await installUpdate(config.url, served);
					ctx.ui.notify(`rmm-relay v${v} installed. Type /reload (or restart pi) to start using it.`, "info");
				} catch (e: any) {
					try { ctx.ui.notify(`RMM relay update failed: ${e?.message || e}. /rmm-status shows the manual command.`, "warning"); } catch { /* ui gone */ }
				}
			}, 1500);
		}
	});

	pi.registerCommand("rmm-update", {
		description: "Update the RMM relay extension to the version the relay serves, then reload",
		handler: async (_args, ctx) => {
			let served = "";
			try { served = await servedClientVersion(config.url); }
			catch (e: any) { return ctx.ui.notify(`Could not reach the relay: ${e?.message || e}`, "error"); }
			if (!served || !isNewer(served, CLIENT_VERSION)) return ctx.ui.notify(`rmm-relay v${CLIENT_VERSION} is up to date.`, "info");
			try {
				const v = await installUpdate(config.url, served);
				ctx.ui.notify(`rmm-relay v${v} installed - reloading.`, "info");
				await ctx.reload();
			} catch (e: any) {
				ctx.ui.notify(`Update failed: ${e?.message || e}`, "error");
			}
		},
	});

	pi.registerCommand("rmm-login", {
		description: "Sign in to the RMM pi relay: your RMM username + a relay key (Settings > AI > pi Relay Keys). /rmm-login <url> to use another relay.",
		handler: async (args, ctx) => {
			// The relay URL is only asked for when given as an argument; otherwise the saved one
			// (or the BlueCloud default) is used - it is the same for everyone.
			syncAccountsFromDisk();   // start from the accounts on disk, not the startup copy
			const url = String(args || "").trim() || config.url || DEFAULT_URL;
			// input()'s second argument is only a placeholder: Enter on an empty box keeps the saved name.
			const saved = config.accounts[0]?.username || "";
			const username = ((await ctx.ui.input("RMM username or email (your RMM login)", saved)) ?? "").trim() || saved;
			const key = (await ctx.ui.input("Relay key (pirk_…) from Settings > AI > pi Relay Keys", ""))?.trim();
			if (!username || !key) return ctx.ui.notify("Cancelled.", "info");
			const a = { username, key };
			let who: Whoami;
			try { who = await fetchWhoami(url.replace(/\/+$/, ""), a); }
			catch (e: any) { return ctx.ui.notify(`Sign-in failed: ${e?.message || e}`, "error"); }
			config.url = url.replace(/\/+$/, "");
			// One account per key: a new key replaces an older one that reached the same groups.
			const newSlugs = new Set(who.groups.map((g) => g.slug));
			config.accounts = config.accounts.filter((x) => {
				if (x.key === key) return false;
				const owned = Object.entries(config.cache || {}).filter(([, c]) => x.key.includes(`_${c.key?.key_id}_`)).map(([s]) => s);
				return !owned.some((s) => newSlugs.has(s));
			});
			for (const s of newSlugs) delete config.cache?.[s];
			config.accounts = [...config.accounts, a];
			applyWhoami(a, who);
			saveConfig(config);
			registerModels(pi);
			registerDelegate(pi);
			const list = who.groups.map((g) => g.slug).join(", ");
			ctx.ui.notify(`Signed in as ${who.user.username} - ${who.groups.length} group(s): ${list}. Use /group <slug>.`, "info");
		},
	});

	pi.registerCommand("rmm-logout", {
		description: "Forget the relay key for a group (or all): /rmm-logout [group]",
		handler: async (args, ctx) => {
			syncAccountsFromDisk();
			const slug = String(args || "").trim();
			if (slug) {
				const a = groups.get(slug);
				groups.delete(slug);
				delete config.cache?.[slug];
				// drop the account only if no other group of ours shares it
				const stillUsed = [...groups.values()].some((x) => x.account === a?.account);
				if (a && !stillUsed) config.accounts = config.accounts.filter((x) => x !== a.account);
			} else {
				groups.clear();
				config.cache = {};
				config.accounts = [];
			}
			saveConfig(config);
			registerModels(pi);
			registerDelegate(pi);
			ctx.ui.notify(slug ? `Signed out of ${slug}.` : "Signed out of all RMM groups.", "info");
		},
	});

	pi.registerCommand("group", {
		description: "Run this chat on an RMM agent group's orchestrator: /group <slug>",
		getArgumentCompletions: (prefix: string) => {
			const items = [...groups.keys()].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const slug = String(args || "").trim() || (groups.size === 1 ? [...groups.keys()][0] : "");
			if (!slug || !groups.has(slug)) return ctx.ui.notify(`Usage: /group <${[...groups.keys()].join("|") || "run /rmm-login first"}>`, "warning");
			const model = ctx.modelRegistry.find(PROVIDER, slug);
			if (!model) return ctx.ui.notify(`Model rmm/${slug} is not registered - try /rmm-status.`, "error");
			const ok = await pi.setModel(model);
			const a = groups.get(slug)!;
			const orch = roleOf(a, "orchestrator");
			currentSlug = slug;
			ctx.ui.notify(ok ? `Now on RMM ${a.group.name}: ${orch?.display_name || "orchestrator"}. Specialists via delegate.` : "Could not switch model.", ok ? "info" : "error");
		},
	});

	pi.registerCommand("rmm-status", {
		description: "Show RMM relay sign-in, groups, specialists and spend",
		handler: async (_args, ctx) => {
			const problems = config.accounts.length ? await refreshAll() : [];
			registerModels(pi);
			registerDelegate(pi);
			const lines = [`relay: ${config.url}   client ${CLIENT_VERSION} / protocol ${PROTOCOL}   config: ${CONFIG_PATH}`];
			const cap = (v: number | null) => (v == null ? "no cap" : `$${v}`);
			for (const [slug, a] of groups) {
				const k = a.key;
				lines.push(`${a.group.name} (${slug}) as ${a.user.username}  key ${k.key_id}${k.label ? ` "${k.label}"` : ""}`);
				lines.push(`   spend: $${k.spend.today_usd.toFixed(2)} today / ${cap(k.daily_budget_usd)}, $${k.spend.month_usd.toFixed(2)} this month / ${cap(k.monthly_budget_usd)}${k.expires_at ? `, expires ${k.expires_at.slice(0, 10)}` : ""}`);
				for (const r of a.group.roles) lines.push(`   ${r.role.padEnd(12)} ${r.display_name} (${r.provider}/${r.model_id}, ${r.thinking_level})${r.model ? "" : "  [not runnable on server]"}`);
			}
			if (!groups.size) lines.push("Not signed in. Run /rmm-login.");
			for (const p of problems) lines.push(`problem: ${p}`);
			// A newer extension on the relay? Say so here - this is the one place a user looks when
			// something is wrong, and it turns "ask an admin" into a copy-paste command.
			try {
				const r = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(5000) });
				const h: any = await r.json();
				const served = String(h?.client_version || "");
				if (served && isNewer(served, CLIENT_VERSION)) {
					lines.push(`UPDATE AVAILABLE: the relay serves rmm-relay v${served}; this computer has v${CLIENT_VERSION}.`);
					lines.push("   Easiest: type /rmm-update (it installs and reloads). Or by hand:");
					lines.push(`   Mac / Linux:  curl -fsSL ${config.url}/client/install.sh | bash`);
					lines.push(`   Windows:      irm ${config.url}/client/install.ps1 | iex`);
					lines.push("   Then restart pi - your sign-in is kept.");
				}
			} catch { /* health is a nicety; never block status */ }
			ctx.ui.notify(lines.join("\n"), problems.length ? "warning" : "info");
		},
	});
}
