// ============================================================================
// 🚀 PEKTOWN — Container Dashboard
// One table. One form. Zero overlay dialogs. Maximum sci-fi vibes. 🛸
// "In the year 2026, containers were managed... beautifully."
// ============================================================================

import "@mariozechner/mini-lit/dist/ThemeToggle.js"; // 🌙☀️ dark/light mode toggle
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import { html, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Plus, Play, Square, ArrowLeft, Settings, KeyRound, ExternalLink, Smartphone, Archive, Upload, Trash2 } from "lucide";
import { icon } from "@mariozechner/mini-lit";
// 📱 QR rendering — tiny lib (~5 KB) that turns a string into an SVG/data-URL
// QR. We get the raw Baileys pairing text from pektown-api (no server-side
// PNG); rendering happens here in the browser.
import qrcode from "qrcode-generator";
import "./app.css";

// ============================================================================
// 📦 Types — one interface to rule them all
// ============================================================================
type AgentRuntime = "openclaw" | "hermes";

interface Container {
	containerName: string;    // 🆔 oc_xxxxx / hm_xxxxx — real docker container id, used in API calls
	agentName: string;        // 🏷️ the customer label shown in the table
	runtime: AgentRuntime;    // 🧬 OpenClaw or Hermes — drives action visibility + claim path
	// 🚦 Three-state rollup from pektown-api, derived from Docker's
	// .State.Running + .State.Health.Status (the openclaw image has a
	// HEALTHCHECK that curls /healthz on the internal gateway port).
	//   "running"  → container up AND gateway healthz passed (bot accepts messages)
	//   "starting" → container up but gateway not yet healthy (15s+ after start)
	//   "stopped"  → container not running
	status: "running" | "starting" | "stopped";
	currentRunHours: number;  // ⏱️ hours in the current run (0 if stopped)
	totalHours: number;       // 📈 cumulative hours across all runs
	// 🧠 AI brain breadcrumb from the server — what provider/model this
	// container is currently configured to run. NULLs are possible for
	// pre-migration containers (until the backfill script runs).
	aiProvider: string | null;     // 'openai' | 'anthropic' | 'openrouter' | null
	aiModel: string | null;        // short id from ai_models.id, e.g. 'gpt-4o-mini'
	aiModelName: string | null;    // human display name for the chip
	// 🔑 Does this container have SOMETHING configured as an AI key? Derived
	// server-side from "ai_provider is not null". The RAW key never comes
	// to the browser — per-provider presence is fetched on demand when the
	// user clicks Edit (see fetchAiKeysStatus).
	aiApiKeySet: boolean;
	aiCredentialSource: "unknown" | "operator_opencode_go" | "owner_key";
}

// 🔑 Per-provider key presence for a single container, fetched from
// GET /containers/:name/ai-keys-status when the user opens the Edit view.
// Every known provider is a boolean — true means "openclaw.json already
// has a working apiKey for this provider, so the user can save without
// re-entering it". Unknown providers are treated as false.
type AiKeyPresence = Record<string, boolean>;

// 🧠 AI model option fetched from GET /ai-models. Mirrors the ai_models row
// shape; used to build the provider + model dropdowns and to resolve a
// provider from a picked model id at validation time.
interface AiModel {
	id: string;
	provider: string;    // 'openai' | 'anthropic'
	model: string;       // full id written to openclaw.json (unused in UI today but kept for completeness)
	baseUrl: string;
	displayName: string;
}

// ============================================================================
// 🔌 pektown-api client — talks to /api/* on this same host (same-origin,
// so no CORS dance required). Every request carries a shared bearer token.
//
// 🔐 Token strategy: the token is NOT baked into the build (the dashboard is
// served at a public URL, anyone could view source). Instead we read it from
// localStorage and prompt on first use. Clearing browser storage logs you out.
// ============================================================================
const API_BASE = "/api";
const GOOGLE_CREDENTIAL_KEY = "googleCredential"; // 🔐 the raw Google JWT (id_token)

// 🔑 Return the Google JWT that GIS handed us on sign-in. We send THIS as the
// bearer to pektown-api — the API verifies it against Google's public keys,
// extracts the user's sub/email, and upserts the Postgres row.
const getApiToken = (): string => localStorage.getItem(GOOGLE_CREDENTIAL_KEY) ?? "";

// 🧹 Kept for backwards-compatibility — signOut() calls this to nuke any old
// cached credential so a 401 loop can't happen.
const clearApiToken = () => localStorage.removeItem(GOOGLE_CREDENTIAL_KEY);

// 🔒 Guard so that if several in-flight requests 401 at the same time (e.g.
// the dashboard's GET /containers plus a pending Start/Stop POST), we only
// trigger ONE page reload. window.location.reload() is idempotent but the
// double-fire is ugly and can drop the first reload's navigation.
let reloadingForAuth = false;

// 🌐 Thin fetch wrapper — sends the Google JWT as the bearer. On 401 we force
// a sign-out so the user is routed back to the sign-in page instead of
// silently looping against a stale token.
const apiFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
	const token = getApiToken();
	const res = await fetch(`${API_BASE}${path}`, {
		...init,
		headers: {
			...(init.headers ?? {}),
			Authorization: `Bearer ${token}`,
		},
	});
	if (res.status === 401) {
		// 🚪 Token rejected (expired, key-rotated, whatever) → nuke both the
		// bearer AND the profile so the post-reload boot check lands on the
		// sign-in view, then reload. Mirrors what signOut() does so both
		// auth-exit paths behave identically.
		localStorage.removeItem(GOOGLE_CREDENTIAL_KEY);
		localStorage.removeItem(GOOGLE_USER_KEY);
		if (!reloadingForAuth) {
			reloadingForAuth = true;
			window.location.reload();
		}
		// 🕳️ Return a never-resolving promise so the caller's .then / await
		// never runs. If we threw here instead, the error would flash in the
		// footer banner for the split-second before reload() fires — ugly.
		return new Promise<Response>(() => {});
	}
	return res;
};

// 📋 GET /api/containers → shape the response to the UI's Container type.
// pektown-api returns state strings like "running", "exited", "created" — we
// collapse anything-that-isn't-running into "stopped" for the table's sake.
const fetchContainers = async (): Promise<Container[]> => {
	const res = await apiFetch("/containers");
	if (!res.ok) throw new Error(`GET /containers ${res.status}`);
	const body = (await res.json()) as {
		containers: Array<{
			container: string;
			customer: string;
			state: string;
			currentRunHours: number;
			totalRunHours: number;
			aiProvider: string | null;
			aiModel: string | null;
			aiModelName: string | null;
			runtime?: AgentRuntime;
			aiApiKeySet: boolean;
			aiCredentialSource?: "unknown" | "operator_opencode_go" | "owner_key";
		}>;
	};
	return body.containers.map((c) => ({
		containerName: c.container,
		agentName: c.customer,
		runtime: c.runtime ?? "openclaw",
		// 🚦 pektown-api now returns a three-state rollup: running / starting /
		// stopped. Anything we don't recognize falls back to "stopped" so an
		// unknown state never shows a green "ready to use" badge by accident.
		status: c.state === "running" ? "running" : c.state === "starting" ? "starting" : "stopped",
		currentRunHours: c.currentRunHours,
		totalHours: c.totalRunHours,
		aiProvider: c.aiProvider,
		aiModel: c.aiModel,
		aiModelName: c.aiModelName,
		aiApiKeySet: c.aiApiKeySet === true,
		aiCredentialSource: c.aiCredentialSource ?? "unknown",
	}));
};

// 🔑 GET /api/containers/:name/ai-keys-status — per-provider key presence
// for the Edit form. Called exactly once when the user clicks Edit (NOT
// on Create — a fresh pool container has no keys anyway). Returns
// { openai, openrouter, anthropic } booleans; unknown providers are
// treated as absent downstream.
const fetchAiKeysStatus = async (containerName: string): Promise<AiKeyPresence> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/ai-keys-status`);
	if (!res.ok) {
		// 📦 Grab whatever shape the server sent and bubble it up — the Edit
		// click handler turns this into a toast. 4xx/5xx are both possible
		// (container vanished, server transient).
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `ai-keys-status failed (${res.status})`);
	}
	return (await res.json()) as AiKeyPresence;
};

// 🧠 GET /api/ai-models — the provider/model menu. Fetched once per session
// after sign-in and cached in module scope. The dashboard + create/edit
// form both read from this cache.
const fetchAiModels = async (): Promise<AiModel[]> => {
	const res = await apiFetch("/ai-models");
	if (!res.ok) throw new Error(`GET /ai-models ${res.status}`);
	const body = (await res.json()) as { models: AiModel[] };
	return body.models;
};

// 🪪 POST /api/containers/claim — body shape must match pektown-api's
// validator exactly; any mismatch comes back as 400 with a descriptive error.
const claimContainer = async (payload: FormState): Promise<{ container: string; customer: string; runtime: AgentRuntime }> => {
	const res = await apiFetch("/containers/claim", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			runtime: payload.runtime,
			agentName: payload.agentName,
			telegramBotToken: payload.telegramBotToken,
			telegramUserIds: payload.telegramUserIds,
		}),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; container?: string; customer?: string; runtime?: AgentRuntime; error?: string; detail?: string };
	if (!res.ok || !body.ok) {
		// 📦 The API returns { error, detail? } on failure; surface both to the UI.
		throw new Error(body.detail ? `${body.error}: ${body.detail}` : body.error ?? `claim failed (${res.status})`);
	}
	return { container: body.container!, customer: body.customer!, runtime: body.runtime ?? payload.runtime };
};

// ✏️ PATCH /api/containers/:name — partial edit. Only fields with non-empty
// values are applied; anything blank means "keep the current value on the
// gateway untouched". Used by the Edit Agent form.
const patchContainer = async (containerName: string, payload: Partial<FormState>): Promise<void> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
	if (!res.ok || !body.ok) {
		throw new Error(body.detail ? `${body.error}: ${body.detail}` : body.error ?? `edit failed (${res.status})`);
	}
};

// ▶️⏹️ POST /api/containers/:name/(start|stop). Both are idempotent on the
// server, so we don't bother pre-checking the current state here.
const postAction = async (containerName: string, action: "start" | "stop"): Promise<void> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/${action}`, {
		method: "POST",
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`${action} ${containerName} failed: ${res.status} ${body}`);
	}
};

// 📦 Backup API — v1 streams a PekTown bundle directly to the browser. No
// server-side retention, no raw OpenClaw/Hermes imports; the uploaded file must
// be our own bundle so restore semantics stay boring and safe. 🧯
type BackupRestoreResult = {
	ok: boolean;
	container: string;
	customer: string;
	runtime: AgentRuntime;
	healthy?: boolean;
	integrationStatus?: {
		google?: "connected" | "reconnect-required" | "unknown";
		whatsapp?: "connected" | "reconnect-required" | "unknown";
	};
};

const downloadContainerBackup = async (containerName: string): Promise<void> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/backup`, { method: "POST" });
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `backup failed (${res.status})`);
	}
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	const disposition = res.headers.get("content-disposition") ?? "";
	const match = disposition.match(/filename="?([^";]+)"?/i);
	a.href = url;
	a.download = match?.[1] ?? `${containerName}-pektown-agent-backup.tar.gz`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
};

const importBackupAsAgent = async (file: File, agentName: string): Promise<BackupRestoreResult> => {
	const fd = new FormData();
	fd.append("file", file);
	fd.append("agentName", agentName);
	const res = await apiFetch("/backups/import", { method: "POST", body: fd });
	const body = (await res.json().catch(() => ({}))) as BackupRestoreResult & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `backup import failed (${res.status})`);
	return body;
};

const cleanDeleteContainer = async (containerName: string, destroyData: boolean): Promise<void> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}?destroyData=${destroyData ? "true" : "false"}`, { method: "DELETE" });
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) throw new Error(body.error ?? `delete failed (${res.status})`);
};

// ============================================================================
// 🎮 Google Workspace OAuth client — talks to the four /google/* routes on
// pektown-api. The actual gog binary + keyring live inside each container;
// these helpers are just the dashboard's HTTP surface for the connect/
// disconnect flow.
//
// Backend contract (see pektown-api/src/index.js):
//   GET  /containers/:n/google/status      → { connected, accounts: [{ email, services, … }] }
//   POST /containers/:n/google/connect-step1 { email } → { authUrl }
//   POST /containers/:n/google/connect-step2 { email, redirectUrl } → { ok, account }
//   POST /containers/:n/google/disconnect      { email } → { ok }
//
// All four are 503 when GOOGLE_OAUTH_CLIENT_ID/SECRET aren't set on the
// host — we feature-detect on first /status call and gate the UI accordingly.
// ============================================================================
type GoogleAccount = { email: string; services?: string; expiresAt?: string };
type GoogleStatus = { connected: boolean; accounts: GoogleAccount[] };

const fetchGoogleStatus = async (containerName: string): Promise<GoogleStatus | "disabled"> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/google/status`);
	// 🚦 503 = backend has no OAuth client configured. Treat as "feature
	// disabled" so callers can hide the badge + button site-wide.
	if (res.status === 503) return "disabled";
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `google/status failed (${res.status})`);
	}
	const body = (await res.json()) as { connected?: boolean; accounts?: GoogleAccount[] };
	return { connected: !!body.connected, accounts: body.accounts ?? [] };
};

const googleConnectStep1 = async (containerName: string, email: string): Promise<{ authUrl: string }> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/google/connect-step1`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
	});
	const body = (await res.json().catch(() => ({}))) as { authUrl?: string; error?: string; detail?: string; hint?: string };
	if (!res.ok || !body.authUrl) {
		const msg = body.detail ? `${body.error}: ${body.detail}` : body.error ?? `connect-step1 failed (${res.status})`;
		throw new Error(body.hint ? `${msg} ${body.hint}` : msg);
	}
	return { authUrl: body.authUrl };
};

const googleConnectStep2 = async (containerName: string, email: string, redirectUrl: string): Promise<{ account: string }> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/google/connect-step2`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, redirectUrl }),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; account?: string; error?: string; detail?: string; hint?: string };
	if (!res.ok || !body.ok) {
		const msg = body.detail ? `${body.error}: ${body.detail}` : body.error ?? `connect-step2 failed (${res.status})`;
		throw new Error(body.hint ? `${msg} ${body.hint}` : msg);
	}
	return { account: body.account ?? email };
};

const googleDisconnect = async (containerName: string, email: string): Promise<void> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/google/disconnect`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
	if (!res.ok || !body.ok) {
		throw new Error(body.detail ? `${body.error}: ${body.detail}` : body.error ?? `disconnect failed (${res.status})`);
	}
};

// ============================================================================
// 📱 WhatsApp client — talks to the three /whatsapp/* routes on pektown-api.
// All real work happens inside a per-container helper.js (Baileys-backed);
// these functions are just the dashboard's HTTP surface.
//
// Backend contract (see pektown-api/src/index.js):
//   GET  /containers/:n/whatsapp/status
//        → { connected, e164?, jid?, qrText?, qrSeq?, expiresAt?,
//            error?, stopped? }
//   POST /containers/:n/whatsapp/login → first-QR snapshot or { pending:true }
//   POST /containers/:n/whatsapp/logout → { ok:true }
//
// We never receive a pre-rendered QR PNG — `qrText` is the raw Baileys
// pairing string. Rendering happens client-side via qrcode-generator (~5 KB).
// ============================================================================
type WhatsappStatus = {
	connected: boolean;
	e164?: string;
	jid?: string;
	qrText?: string;
	qrSeq?: number;
	expiresAt?: number;
	error?: string;
	stopped?: boolean;
	pending?: boolean;
};

const fetchWhatsappStatus = async (containerName: string): Promise<WhatsappStatus> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/whatsapp/status`);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `whatsapp/status failed (${res.status})`);
	}
	return (await res.json()) as WhatsappStatus;
};

const startWhatsappLogin = async (containerName: string): Promise<WhatsappStatus> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/whatsapp/login`, {
		method: "POST",
	});
	const body = (await res.json().catch(() => ({}))) as WhatsappStatus & { error?: string; detail?: string };
	if (!res.ok) {
		throw new Error(body.detail ? `${body.error}: ${body.detail}` : body.error ?? `whatsapp/login failed (${res.status})`);
	}
	return body;
};

const whatsappLogout = async (containerName: string): Promise<void> => {
	const res = await apiFetch(`/containers/${encodeURIComponent(containerName)}/whatsapp/logout`, {
		method: "POST",
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
	if (!res.ok || !body.ok) {
		throw new Error(body.detail ? `${body.error}: ${body.detail}` : body.error ?? `whatsapp/logout failed (${res.status})`);
	}
};

// 🧠 Dynamic model list — populated from GET /ai-models once per session.
// The old hardcoded AI_MODELS is gone; the server's ai_models table is now
// the single source of truth, so adding a new model is a SQL insert rather
// than a code change in two repos.
let aiModels: AiModel[] = [];

// 🏷️ Friendly label for a provider id. Extend this if new providers get
// added to ai_models — unknown providers fall through to the raw id so the
// dropdown is still usable.
const providerLabel = (provider: string): string => {
	switch (provider) {
		case "openai": return "OpenAI";
		case "anthropic": return "Anthropic";
		case "openrouter": return "OpenRouter";  // 🌐 one key, many models
		case "opencode-go": return "OpenCode Go";
		default: return provider;
	}
};

// 📝 Placeholder for the API-key field based on selected provider. Matches
// the canonical key prefix each provider hands out, so copy/paste users see
// familiar shape hints.
const keyPlaceholderFor = (provider: string): string => {
	switch (provider) {
		case "openai": return "sk-...";
		case "anthropic": return "sk-ant-...";
		case "openrouter": return "sk-or-v1-...";  // 🌐 OpenRouter key prefix
		case "opencode-go": return "Paste your OpenCode Go API key";
		default: return "API key";
	}
};

// 🎯 Provider-choice list derived from the loaded ai_models. De-dupes and
// preserves server-side sort_order (first occurrence wins).
const providerOptions = (): Array<{ value: string; label: string }> => {
	const seen = new Set<string>();
	const options: Array<{ value: string; label: string }> = [];
	for (const m of aiModels) {
		if (seen.has(m.provider)) continue;
		seen.add(m.provider);
		options.push({ value: m.provider, label: providerLabel(m.provider) });
	}
	return options;
};

// 🎯 Model-choice list filtered to a given provider. Used as the dependent
// dropdown below the provider selector.
const modelOptionsFor = (provider: string): Array<{ value: string; label: string }> =>
	aiModels.filter((m) => m.provider === provider).map((m) => ({ value: m.id, label: m.displayName }));

// 🔎 Helper: find the AiModel row for a given short id. Returns undefined
// if the id doesn't match any loaded model (e.g. model was deleted server-side
// between fetch and form submit — rare, handled by validator).
const aiModelById = (id: string): AiModel | undefined => aiModels.find((m) => m.id === id);

// ============================================================================
// 🔐 Google Sign-In — client-side only. The GIS script loads asynchronously,
// so we poll for window.google then render the button into a container div.
// The JWT credential is decoded in the browser (no backend verification) —
// the real auth gate is still the pektown-api bearer token.
// ============================================================================
const GOOGLE_CLIENT_ID = "106317999884-5k2h0kcss2shd9037kioclg7pn1dmuia.apps.googleusercontent.com";
const GOOGLE_USER_KEY = "googleUser";

// 👤 Shape of the decoded Google JWT payload bits we actually use.
// ⏰ `exp` is cached alongside the profile so `loadSavedUser()` can cheaply
// reject an expired credential at boot without re-decoding the JWT on every
// page load. Optional so older cached profiles (pre-fix) don't break —
// they'll simply be treated as "expiry unknown" and re-decoded on demand.
type GoogleUser = {
	sub: string;     // 🆔 Google account ID (stable)
	email: string;   // ✉️ primary email
	name: string;    // 🏷️ display name
	picture: string; // 🖼️ avatar URL
	exp?: number;    // ⏰ JWT expiry (unix seconds) — fast-path cache of googleCredential.exp
};

let signedInUser: GoogleUser | null = null; // 📍 null = logged out, show sign-in page
let googleInitialized = false;              // 🧷 guard so we only call initialize once

// 🔓 Base64URL-decode the middle segment of a JWT. Client-side only — we trust
// the token because it's only used to personalize the UI; the bearer token is
// the real security boundary.
const decodeJwt = (token: string): GoogleUser | null => {
	try {
		const payload = token.split(".")[1];
		const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
		const obj = JSON.parse(decodeURIComponent(escape(json)));
		// ⏰ Also pluck `exp` so callers can do boot-time expiry checks
		// without re-decoding. Type it defensively — the JWT spec says it's a
		// number, but we treat anything non-numeric as "unknown expiry."
		const exp = typeof obj.exp === "number" ? obj.exp : undefined;
		return { sub: obj.sub, email: obj.email, name: obj.name, picture: obj.picture, exp };
	} catch {
		return null;
	}
};

// 💾 Load saved user on boot (survives refresh).
// ⏰ Also validates that the cached googleCredential is still within its
// JWT `exp` window (with a 60s safety margin) — otherwise we'd render the
// dashboard shell, fire a request, eat a 401, and reload. Catching expiry
// here means expired returning users land on the sign-in view directly,
// with zero flash and zero wasted round trip to pektown-api.
const EXPIRY_SAFETY_MS = 60_000; // 🛟 guard against clock skew + in-flight latency
const loadSavedUser = (): void => {
	const raw = localStorage.getItem(GOOGLE_USER_KEY);
	if (!raw) return;

	// 🔍 A profile without a matching credential is useless — every API call
	// would 401 immediately. Clear the orphan profile and bail.
	const credential = localStorage.getItem(GOOGLE_CREDENTIAL_KEY);
	if (!credential) {
		localStorage.removeItem(GOOGLE_USER_KEY);
		return;
	}

	let parsed: GoogleUser;
	try {
		parsed = JSON.parse(raw) as GoogleUser;
	} catch {
		// 💥 Corrupt profile JSON — nuke both sides so the next render is the
		// sign-in view, not a half-initialized dashboard.
		localStorage.removeItem(GOOGLE_USER_KEY);
		localStorage.removeItem(GOOGLE_CREDENTIAL_KEY);
		return;
	}

	// ⏰ Expiry check. Prefer the cached `exp` on the profile (cheap); fall
	// back to decoding the JWT for profiles written before this fix shipped.
	let exp = parsed.exp;
	if (typeof exp !== "number") {
		const decoded = decodeJwt(credential);
		exp = decoded?.exp;
	}
	// 🚪 Missing/invalid exp OR already past (with safety margin) → treat as
	// expired. Clear both keys; the caller will render the sign-in view.
	if (typeof exp !== "number" || exp * 1000 <= Date.now() + EXPIRY_SAFETY_MS) {
		localStorage.removeItem(GOOGLE_USER_KEY);
		localStorage.removeItem(GOOGLE_CREDENTIAL_KEY);
		return;
	}

	signedInUser = parsed;
};

// 🚪 Sign out — clear local state AND revoke the Google grant so the next
// render shows a plain "Sign in with Google" button (not a personalized one
// with the user's email baked in). revoke() is async but we don't need to
// wait on it; best-effort is fine.
// 🚦 Before opening flows that will definitely call the API (Create Agent,
// Create from Backup), make sure the cached Google JWT is still fresh. This
// avoids the confusing UX where the form opens, the user fills it out, and
// only then pektown-api says “nope, that token expired 20 minutes ago.” If the
// credential is missing/expired, drop them straight back on the login page.
const ensureActiveGoogleSession = (): boolean => {
	const credential = localStorage.getItem(GOOGLE_CREDENTIAL_KEY);
	const decoded = credential ? decodeJwt(credential) : null;
	if (!decoded?.exp || decoded.exp * 1000 <= Date.now() + EXPIRY_SAFETY_MS) {
		signedInUser = null;
		currentView = "dashboard";
		localStorage.removeItem(GOOGLE_USER_KEY);
		localStorage.removeItem(GOOGLE_CREDENTIAL_KEY);
		renderApp();
		return false;
	}
	// 🪪 Keep the in-memory/user cache aligned if GIS gave us a newer token.
	signedInUser = decoded;
	localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(decoded));
	return true;
};

const signOut = (): void => {
	const email = signedInUser?.email;
	signedInUser = null;
	localStorage.removeItem(GOOGLE_USER_KEY);
	clearApiToken(); // 🔑 also drop the stashed Google JWT
	const g = (window as unknown as {
		google?: { accounts?: { id?: {
			disableAutoSelect?: () => void;
			revoke?: (hint: string, cb?: () => void) => void;
		} } };
	}).google;
	g?.accounts?.id?.disableAutoSelect?.();
	// 🧹 Revoke wipes the prior consent so the button returns to its
	// non-personalized form. No-op if the user never granted anything.
	// 🔄 Full reload AFTER revoke completes — revoke() is async and GIS
	// caches personalized button state; reloading too early races the revoke
	// and sometimes leaves the user's email baked into the button.
	// 🛟 Also reload if revoke is unavailable or takes too long.
	const doReload = () => window.location.reload();
	if (email && g?.accounts?.id?.revoke) {
		let reloaded = false;
		const once = () => { if (!reloaded) { reloaded = true; doReload(); } };
		g.accounts.id.revoke(email, once);
		setTimeout(once, 800); // ⏱️ fallback if the callback never fires
	} else {
		doReload();
	}
};

// 🎉 GIS callback — fires when user picks a Google account and approves.
// We stash BOTH the decoded profile (for UI) AND the raw JWT (as the bearer
// we send to pektown-api on every request).
const handleCredentialResponse = (response: { credential: string }): void => {
	const user = decodeJwt(response.credential);
	if (!user) return;
	signedInUser = user;
	// 💾 Persist the full decoded profile INCLUDING `exp` — `loadSavedUser`
	// reads `exp` at boot to short-circuit expired sessions before they 401.
	localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(user));
	localStorage.setItem(GOOGLE_CREDENTIAL_KEY, response.credential);
	renderApp();
	void loadContainers(); // 📡 first fetch now that we have a user
	void loadAiModels();   // 🧠 populate provider/model dropdowns
};

// 🪄 Render the Google sign-in button into the element with id="google-btn".
// Polls briefly because the GIS <script async defer> may not be ready yet.
const renderGoogleButton = (): void => {
	const target = document.getElementById("google-btn");
	if (!target) return;
	const g = (window as unknown as { google?: { accounts?: { id?: { initialize: (c: unknown) => void; renderButton: (el: HTMLElement, o: unknown) => void } } } }).google;
	if (!g?.accounts?.id) {
		// ⏳ GIS not loaded yet — retry shortly. Bounded by the fact that the
		// script is <script async> on the same page, so it arrives in ms.
		setTimeout(renderGoogleButton, 100);
		return;
	}
	if (!googleInitialized) {
		g.accounts.id.initialize({
			client_id: GOOGLE_CLIENT_ID,
			callback: handleCredentialResponse,
		});
		googleInitialized = true;
	}
	g.accounts.id.renderButton(target, {
		theme: "outline",
		size: "large",
		shape: "pill",
		text: "signin_with",
		width: 260,
	});
};

// ============================================================================
// 🗄️ State — one array, a view flag, plus async status bits.
// Simplicity is the ultimate sophistication. — Leonardo da Vinci (probably)
// ============================================================================
let containers: Container[] = []; // 📭 starts empty; fetched on mount
let currentView: "dashboard" | "create" | "edit" | "connect-google" | "connect-whatsapp" | "import-backup" | "delete-agent" = "dashboard"; // 📍 which "page" we're on
// ✏️ When in edit mode, which container we're editing. The form re-uses the
// create UI but swaps its header + submit behavior based on this being set.
let editingContainer: { containerName: string; agentName: string; runtime: AgentRuntime } | null = null;
let isLoading = false;            // ⏳ initial fetch in flight (shows a "loading…" row)
let loadError: string | null = null; // ❌ last fetch/action error, surfaced in the footer
let busyContainer: string | null = null; // 🔒 container name currently mid-action, for button disabling
let backupBusyContainer: string | null = null; // 📦 row currently preparing a browser download
let selectedBackupFile: File | null = null;
let backupNewAgentName = "";
let backupImportError: string | null = null;
let backupImportResult: BackupRestoreResult | null = null;
let isImportingBackup = false;
let dashboardSuccessMessage: string | null = null;
let deletingContainer: Container | null = null;
let deleteConfirmText = "";
let isDeletingContainer = false;

// 📝 Create-Agent form state. Kept at module scope so the inputs can update
// without re-rendering on every keystroke (which would kill focus). Only
// submit/cancel trigger a re-render.
type FormState = {
	runtime: AgentRuntime;
	agentName: string;
	telegramBotToken: string;
	telegramUserIds: string;
	aiProvider: string; // 'openai' | 'anthropic' — drives which models show + which key label/placeholder render
	aiModel: string;    // ai_models.id, e.g. 'gpt-4o-mini'
	aiApiKey: string;
};

// 🧠 Seed the form's provider/model with the first available option from
// the loaded ai_models cache. Falls back to sensible openai defaults if the
// cache is still empty (e.g. a rogue render before loadAiModels resolves).
const defaultFormAiFields = (): Pick<FormState, "aiProvider" | "aiModel"> => {
	const opencodeDefault = aiModels.find((m) => m.id === "opencode-go-qwen3-6-plus");
	if (opencodeDefault) return { aiProvider: opencodeDefault.provider, aiModel: opencodeDefault.id };
	const gpt5Mini = aiModels.find((m) => m.id === "gpt-5-mini");
	if (gpt5Mini) return { aiProvider: gpt5Mini.provider, aiModel: gpt5Mini.id };
	if (aiModels.length > 0) {
		const first = aiModels[0];
		return { aiProvider: first.provider, aiModel: first.id };
	}
	return { aiProvider: "opencode-go", aiModel: "opencode-go-qwen3-6-plus" };
};

const forceHermesV1AiFields = () => {
	formData.aiProvider = "opencode-go";
	formData.aiModel = "opencode-go-qwen3-6-plus";
};

const emptyForm = (): FormState => ({
	runtime: "openclaw",
	agentName: "",
	telegramBotToken: "",
	telegramUserIds: "",
	aiApiKey: "",
	...defaultFormAiFields(),
});
let formData: FormState = emptyForm();
let isSubmittingForm = false; // ⏳ POST /claim in flight — disables the button
let formError: string | null = null; // ❌ last submit error (validation or API)

// ============================================================================
// 🎮 Google Workspace Connect — state for the per-container OAuth flow.
//
// The connect screen is a full-screen view (mirrors the Edit Agent pattern),
// not a modal. Two steps in the same view: step 1 mints an auth URL via gog,
// step 2 exchanges the user-pasted redirect URL for tokens. Between the two,
// the user goes off to accounts.google.com, approves, copies the failing
// loopback URL back from their address bar.
// ============================================================================

// 📍 Which container's connect screen are we on? Set by openConnectGoogleView,
// cleared by the Back button.
let connectContainer: { containerName: string; agentName: string; runtime: AgentRuntime } | null = null;

// ✉️ Email the user typed in step 1. Required for step 2 (gog uses it as the
// keyring entry key) so we hold it across the two requests.
let connectEmail = "";

// 🔗 Auth URL returned by step 1. While null, the form shows only step 1
// (email + Get auth link). Once set, step 2 (paste redirect URL + Connect)
// becomes visible.
let connectAuthUrl: string | null = null;

// 📋 What the user pastes back from their browser address bar.
let connectRedirectUrl = "";

// ❌ Inline error for the connect screen — same role as formError on the
// create/edit form. Cleared on every fresh action.
let connectError: string | null = null;

// ⏳ Tracks which connect-screen action is mid-flight, so we can disable the
// right button without disabling the whole form: "step1" while getting the
// auth link, "step2" while exchanging tokens, or an email string while a
// disconnect is processing for that account.
let connectInFlight: "step1" | "step2" | string | null = null;

// 📊 Current Google connection status for the container we're viewing.
// `null` = haven't fetched yet, "disabled" = backend has no OAuth client
// configured (503), otherwise the parsed { connected, accounts } payload.
let connectStatus: GoogleStatus | "disabled" | null = null;

// 🌐 Per-row status cache so dashboard rows can show a green/gray badge
// without each render firing four-way fetches. Populated by
// refreshGoogleStatuses() right after loadContainers, and on every Connect
// screen back-navigation. Empty map = "haven't checked yet".
const gogStatusByContainer = new Map<string, GoogleStatus>();

// 🎛️ Single feature flag — flips false the first time any /google/status
// returns 503 (the backend has no OAuth client configured), and we then
// hide every gog UI element site-wide. Starts true (optimistic) so the
// button shows up by default; flips and stays false on first 503.
let gogEnabled = true;

// ============================================================================
// 📱 WhatsApp Connect — state for the per-container login flow.
//
// Connect screen is full-screen (mirrors Connect Google pattern). Status is
// polled every 3 s while the screen is open and not yet connected; the QR
// auto-refreshes via Baileys' ~20 s rotation, so each poll might pick up a
// new qrSeq → we re-render the canvas. On `connected:true` we flip to the
// "logged in" view; on `error` we show a Try Again button.
// ============================================================================
let connectWhatsappContainer: { containerName: string; agentName: string } | null = null;

// 📡 Latest status snapshot for the open Connect-WhatsApp screen. `null` =
// loading. Populated by openConnectWhatsappView + the 3 s poll loop.
let waState: WhatsappStatus | null = null;

// ⏳ "We're talking to the helper right now" spinner targets — same role as
// connectInFlight on the Google screen.
let waInFlight: "login" | "logout" | null = null;

// ❌ Inline error for the Connect-WhatsApp screen.
let waError: string | null = null;

// 🔁 Poll handle for the Connect-WhatsApp screen. Started in
// openConnectWhatsappView, cleared on Back / unmount / connected / error.
let waPollHandle: number | null = null;

// 👋 "User just hit Logout, and the unlink succeeded" flag. Without this,
// after logout the render falls through to the QR-generating spinner because
// {connected:false} alone matches no specific branch — and it would feel like
// the page silently re-spawned a new login behind the user's back. With the
// flag set we paint a friendly "Disconnected — see you later 👋" card with
// explicit Reconnect / Back buttons, putting the user in control of what
// happens next instead of auto-restarting the QR dance.
let waJustLoggedOut = false;

// 🌐 Per-row status cache for the dashboard rows' green/gray dot. Populated
// by refreshWhatsappStatuses(), which only runs ONCE on initial page load
// and again when the user returns from the Connect-WhatsApp screen.
const waStatusByContainer = new Map<string, WhatsappStatus>();

// 🚧 Tracks whether the one-shot initial WhatsApp status sweep has run yet,
// so refreshWhatsappStatuses self-no-ops on subsequent loadContainers ticks.
let waInitialRefreshDone = false;

// ⏳ Track which row's gog status is currently being fetched, so the dashboard
// can dim its badge instead of flashing "disconnected" mid-fetch.
const gogStatusFetching = new Set<string>();

// 🔢 Format hours nicely: 1.23 → "1.23h"
const formatHours = (hours: number): string => hours.toFixed(2) + "h";

// ============================================================================
// 🐦 Woodpecker SVG — custom side-view woodpecker with a prominent beak
// The beak is rendered in a warm contrasting orange/amber color 🔶
// No Lucide icon for this one — hand-crafted with love. 🪶
// ============================================================================
// 📐 viewBox is shifted so the BODY ellipse (cx=24, rx=16) lands at the
// horizontal center of the viewBox — width=100 with x_start=-26 puts body
// center at x=50, i.e. 50% of width. That way when the SVG is centered in
// its container, the body (the visual "weight" of the bird) is centered too,
// instead of the whole bounding box including the beak that sticks out right.
const woodpeckerSvg = html`
<svg class="brand-icon-svg" viewBox="-26 0 100 56" fill="none" xmlns="http://www.w3.org/2000/svg">
	<!-- 🐦 Body ellipse -->
	<ellipse cx="24" cy="32" rx="16" ry="20" fill="currentColor" opacity="0.85"/>
	<!-- 🦅 Head ellipse -->
	<ellipse cx="36" cy="16" rx="12" ry="11" fill="currentColor" opacity="0.85"/>
	<!-- 👁️ Eye -->
	<circle cx="40" cy="14" r="3" fill="white"/>
	<circle cx="40.8" cy="13.8" r="1.5" fill="#0f172a"/>
	<!-- 🔶 BEAK -->
	<path d="M47,10 Q72,14 47,22 Z" fill="#f59e0b" stroke-linejoin="round"/>
	<!-- 🦶 Legs -->
	<line x1="20" y1="50" x2="18" y2="56" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
	<line x1="28" y1="50" x2="28" y2="56" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// ============================================================================
// 🏷️ Branding Bar — Woodpecker + Pektown + Theme Toggle
// 80px reduced by 40% = 48px. Compact header. All business. 🎯
// ============================================================================
const renderBranding = () => html`
	<div class="flex items-center justify-between mb-3 fade-in">
		<!-- 🐦 Logo block — woodpecker + name, 48px tall -->
		<div class="brand-block">
			<!-- 🐦 Woodpecker with that glorious orange beak -->
			<div class="brand-icon">
				${woodpeckerSvg}
			</div>

			<!-- 🏷️ Product name — Inter font, matched to icon height -->
			<h1 class="brand-name brand-gradient">
				Pektown
			</h1>
		</div>

		<!-- 🚪 Logout button (left) + 🌙☀️ theme toggle (right) -->
		<div class="flex items-center gap-2">
			${signedInUser ? html`
				<button
					class="flex items-center gap-2 text-sm px-2 py-1 rounded-md hover:bg-muted transition-colors bg-transparent border border-border cursor-pointer"
					title="Sign out ${signedInUser.email}"
					@click=${signOut}
				>
					<!-- 🖼️ Avatar — Google-hosted, tiny -->
					<img src=${signedInUser.picture} alt="" class="w-6 h-6 rounded-full" referrerpolicy="no-referrer" />
					<span class="hidden sm:inline text-muted-foreground">${signedInUser.name}</span>
					<span class="text-xs opacity-60">Sign out</span>
				</button>
			` : ""}
			<theme-toggle></theme-toggle>
		</div>
	</div>
`;

// ============================================================================
// 🔁 Shared row/card state — computes derived flags + the Start/Stop click
// handler. Used by BOTH the desktop table row and the mobile card, so the two
// layouts can never drift on behaviour (only on visual shape). 🎯
// ============================================================================
type RowState = {
	isRunning: boolean;
	isStarting: boolean;
	isBusy: boolean;
	action: "start" | "stop";
	onClick: () => Promise<void>;
};
const rowState = (c: Container): RowState => {
	const isRunning = c.status === "running";
	const isStarting = c.status === "starting";
	// 🔒 Busy while our own action is in flight OR while the openclaw gateway
	// is still coming up — in both cases clicking Start/Stop now would either
	// race or stop a half-started container. Cleaner to just disable.
	const isBusy = busyContainer === c.containerName || isStarting;
	// 🎯 When "starting", stop is the semantically correct action if the user
	// ever does click. But since the button is disabled anyway, this is only
	// used to pick the spinner label ("stopping" would be wrong).
	const action: "start" | "stop" = isRunning || isStarting ? "stop" : "start";
	// 🎯 Fire action, show spinner via re-render, refetch to reflect reality.
	const onClick = async () => {
		if (isBusy) return;
		busyContainer = c.containerName;
		loadError = null;
		renderApp();
		try {
			await postAction(c.containerName, action);
			await loadContainers();
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			busyContainer = null;
			renderApp();
		}
	};
	// 🪲 isStarting MUST be returned — the render sites branch on it first to
	// pick the "Starting…" label. Dropping it here sent the fallback branch
	// to `action === "stop" ? "stopping" : "starting"`, and because we flip
	// `action` to "stop" while starting (for click semantics), the spinner
	// mis-rendered as "stopping". 🙈
	return { isRunning, isStarting, isBusy, action, onClick };
};

const handleBackupClick = async (c: Container) => {
	if (c.status !== "running" || backupBusyContainer) return;
	backupBusyContainer = c.containerName;
	loadError = null;
	renderApp();
	try {
		await downloadContainerBackup(c.containerName);
	} catch (err) {
		loadError = (err as Error).message;
	} finally {
		backupBusyContainer = null;
		renderApp();
	}
};

const openDeleteView = (c: Container) => {
	deletingContainer = c;
	deleteConfirmText = "";
	currentView = "delete-agent";
	renderApp();
};

// ============================================================================
// 📋 Table Row — one row per agent container (💻 desktop only)
// 🟢 running = pulsing green dot + Stop button
// ⚪ stopped = gray dot + Start button
// Row height matches form field height for visual consistency 📏
// ============================================================================
const renderRow = (c: Container) => {
	const { isRunning, isStarting, isBusy, action, onClick } = rowState(c);
	const isHermes = c.runtime === "hermes";

	return html`
		<tr class="border-b border-border/50 transition-colors">
			<!-- 🏷️ Agent name + tiny model/provider chip underneath, so the
			     operator can tell at-a-glance which brain is doing the thinking. -->
			<td class="px-4 py-2 font-mono text-sm">
				<div class="font-medium">${c.agentName}</div>
				<div class="text-xs opacity-70 mt-0.5">${isHermes ? "🪽 Hermes" : "🦀 OpenClaw"}</div>
				${c.aiModelName || c.aiProvider
					? html`<div class="text-xs opacity-60 mt-0.5">✔️ ${c.aiModelName ?? c.aiModel ?? "—"}${c.aiProvider ? html` · ${providerLabel(c.aiProvider)}` : ""}</div>`
					: html`<div class="text-xs opacity-40 mt-0.5">✔️ no model configured</div>`}
			</td>

			<!-- 🚦 Status badge with animated dot.
			     🟢 running → green pulse
			     🟡 starting → amber pulse (gateway not yet accepting messages)
			     ⚪ stopped → gray, static -->
			<td class="px-4">
				${Badge({
					variant: isRunning ? "default" : "secondary",
					children: html`<span class="flex items-center gap-1.5">
						<span class="w-2 h-2 rounded-full ${isRunning ? "bg-green-400 pulse-dot" : isStarting ? "bg-amber-400 pulse-dot" : "bg-gray-500"}"></span>
						${c.status}
					</span>`,
				})}
			</td>

			<!-- 📊 Usage — current run + lifetime total in one compact column.
			     Stacking them keeps the table narrow without hiding the two numbers
			     operators care about when eyeballing spend. 💸 -->
			<td class="px-4 tabular-nums font-mono text-sm col-hours">
				<div>${isRunning || isStarting ? formatHours(c.currentRunHours) : "—"} <span class="text-xs opacity-60">(current run)</span></div>
				<div class="mt-0.5">${formatHours(c.totalHours)} <span class="text-xs opacity-60">(total usage)</span></div>
			</td>

			<!-- 🎮 Action buttons — Start/Stop + ✏️ Edit side by side. Edit
			     is disabled when the container isn't running, because the
			     edit flow docker-execs into the container to patch
			     openclaw.json — exec into a stopped container fails with
			     "container is not running". The wrapping <span> carries the
			     tooltip so it still shows on hover (the disabled button
			     itself has pointer-events: none). -->
			<td class="px-4">
				<div class="flex items-center gap-2">
					${Button({
						variant: "outline",
						size: "sm",
						className: "glow-btn",
						disabled: isBusy,
						onClick,
						children: isStarting
							? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Starting…</span>`
							: isBusy
								? html`<span class="flex items-center gap-1.5 opacity-70">…${action === "stop" ? "stopping" : "starting"}</span>`
								: isRunning
									? html`<span class="flex items-center gap-1.5">${icon(Square, "xs")} Stop</span>`
									: html`<span class="flex items-center gap-1.5">${icon(Play, "xs")} Start</span>`,
					})}
					<span title="${isRunning ? "" : "please start agent to edit"}" class="inline-flex">
						${Button({
							variant: "outline",
							size: "sm",
							className: "glow-btn",
							// ⏳ Disable while this row's /ai-keys-status fetch is in flight,
							// otherwise a double-click would fire two requests. Everyone else
							// stays clickable so a slow fetch on one row doesn't freeze the
							// whole table. 🪽 Hermes now supports the same edit flow too.
							disabled: !isRunning || editLoadingContainer === c.containerName,
							onClick: () => void openEditView(c),
							children: editLoadingContainer === c.containerName
								? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Loading…</span>`
								: html`<span class="flex items-center gap-1.5">${icon(Settings, "xs")} Edit</span>`,
						})}
					</span>
<!-- 🔑 Google API — opens the Connect Google screen for this row.
					     Only renders when the host has an OAuth client configured
					     (gogEnabled). The dot before "Google" mirrors the per-row
					     status: 🟢 = at least one account connected, ⚪ = none.
					     Disabled on stopped containers, mirroring the Edit button:
					     the four /google/* routes auto-start the container, but the
					     status check can't peek into a stopped keyring, so the dot
					     would be misleading until the user actually opened the
					     screen. Cleaner to gate the button on isRunning. -->
					${gogEnabled ? html`
						<span title="${isRunning ? "Connect a Google account so the agent can use Google Workspace." : "please start agent to connect Google"}" class="inline-flex">
							${Button({
								variant: "outline",
								size: "sm",
								className: "glow-btn",
								disabled: !isRunning,
								onClick: () => void openConnectGoogleView(c),
								children: html`<span class="flex items-center gap-1.5">
									<span class="w-2 h-2 rounded-full ${gogStatusByContainer.get(c.containerName)?.connected ? "bg-green-400" : "bg-gray-500"}"></span>
									${icon(KeyRound, "xs")} Google
								</span>`,
							})}
						</span>
					` : ""}
					<!-- 📱 WhatsApp — opens the Connect-WhatsApp screen for this row.
					     Same gating as Google: disabled when stopped (the helper
					     needs the gateway online to docker-exec into). The dot
					     mirrors the cached per-row status: 🟢 = linked, ⚪ = not. -->
					<span title="${isRunning ? "Link a WhatsApp account so the agent can chat on WhatsApp." : "please start agent to connect WhatsApp"}" class="inline-flex">
						${Button({
							variant: "outline",
							size: "sm",
							className: "glow-btn",
							disabled: !isRunning,
							onClick: () => void openConnectWhatsappView(c),
							children: html`<span class="flex items-center gap-1.5">
								<span class="w-2 h-2 rounded-full ${waStatusByContainer.get(c.containerName)?.connected ? "bg-green-400" : "bg-gray-500"}"></span>
								${icon(Smartphone, "xs")} WhatsApp
							</span>`,
						})}
					</span>
					<span title="${isRunning ? "Download a PekTown backup bundle." : "backup is available only while running in v1"}" class="inline-flex">
						${Button({
							variant: "outline",
							size: "sm",
							className: "glow-btn",
							disabled: !isRunning || backupBusyContainer === c.containerName,
							onClick: () => void handleBackupClick(c),
							children: backupBusyContainer === c.containerName
								? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Backup…</span>`
								: html`<span class="flex items-center gap-1.5">${icon(Archive, "xs")} Backup</span>`,
						})}
					</span>
				</div>
			</td>
		</tr>
	`;
};

// ============================================================================
// 📱 Mobile Card — stacked layout for phones. WhatsApp-style: one tappable
// card per container, fields laid out top-to-bottom with familiar emojis so
// the UI reads like a chat app at a glance. No horizontal scroll, no tiny
// columns. The action button stretches full-width for fat-finger friendliness.
// ============================================================================
const renderCard = (c: Container) => {
	const { isRunning, isStarting, isBusy, action, onClick } = rowState(c);
	const isHermes = c.runtime === "hermes";

	// 🎨 Status emoji + dot color + label — three-state (starting / running / stopped)
	const statusEmoji = isRunning ? "🟢" : isStarting ? "🟡" : "⚪";
	const dotColor = isRunning ? "bg-green-400 pulse-dot" : isStarting ? "bg-amber-400 pulse-dot" : "bg-gray-500";
	const badgeVariant: "default" | "secondary" = isRunning ? "default" : "secondary";

	return html`
		<div class="p-4 flex flex-col gap-3">
			<!-- 🤖 Agent identity — biggest text, breaks on long customer ids.
			     Model + provider chip lives right underneath for quick recognition. -->
			<div class="flex flex-col gap-0.5">
				<div class="flex items-center gap-2">
					<span class="text-lg" aria-hidden="true">🤖</span>
					<span class="font-medium font-mono text-base break-all">${c.agentName}</span>
				</div>
				<div class="text-xs font-mono opacity-70 pl-7">${isHermes ? "🪽 Hermes" : "🦀 OpenClaw"}</div>
				${c.aiModelName || c.aiProvider
					? html`<div class="text-xs font-mono opacity-60 pl-7">✔️ ${c.aiModelName ?? c.aiModel ?? "—"}${c.aiProvider ? html` · ${providerLabel(c.aiProvider)}` : ""}</div>`
					: html`<div class="text-xs font-mono opacity-40 pl-7">✔️ no model configured</div>`}
			</div>

			<!-- 🟢/🟡/⚪ Status — emoji dot mirrors the Badge's colored dot so the
			     state reads even if the Badge styling misbehaves on a tiny screen -->
			<div class="flex items-center gap-2">
				<span aria-hidden="true">${statusEmoji}</span>
				${Badge({
					variant: badgeVariant,
					children: html`<span class="flex items-center gap-1.5">
						<span class="w-2 h-2 rounded-full ${dotColor}"></span>
						${c.status}
					</span>`,
				})}
			</div>

			<!-- ⏱️ Current run — always shown (dash when stopped) so the user
			     sees the same fields as the desktop table, in the same order. -->
			<div class="flex items-center gap-2 text-sm text-muted-foreground font-mono tabular-nums">
				<span aria-hidden="true">⏱️</span>
				<span>Current run: ${isRunning || isStarting ? formatHours(c.currentRunHours) : "—"}</span>
			</div>

			<!-- 📈 Cumulative hours across all runs -->
			<div class="flex items-center gap-2 text-sm text-muted-foreground font-mono tabular-nums">
				<span aria-hidden="true">📈</span>
				<span>Total: ${formatHours(c.totalHours)}</span>
			</div>

			<!-- ▶️/⏹️ + ✏️ Actions — two full-width buttons stacked under the
			     card. Edit is always clickable since it doesn't race with
			     Start/Stop. -->
			${Button({
				variant: "outline",
				className: "glow-btn w-full",
				disabled: isBusy,
				onClick,
				children: isStarting
					? html`<span class="flex items-center justify-center gap-1.5 opacity-70">⏳ Starting…</span>`
					: isBusy
						? html`<span class="flex items-center justify-center gap-1.5 opacity-70">⏳ ${action === "stop" ? "stopping" : "starting"}…</span>`
						: isRunning
							? html`<span class="flex items-center justify-center gap-1.5">⏹️ Stop</span>`
							: html`<span class="flex items-center justify-center gap-1.5">▶️ Start</span>`,
			})}
			<!-- ✏️ Edit — disabled when the container isn't running, since the
			     edit flow needs to docker-exec into the gateway. The <span>
			     wrapper carries the tooltip so it still shows on tap/hover
			     (the disabled button has pointer-events: none). -->
			<span title="${isRunning ? "" : "please start agent to edit"}" class="block w-full">
				${Button({
					variant: "outline",
					className: "glow-btn w-full",
					// ⏳ Same story as the desktop row — disable this card's button
					// while its own presence fetch is running, so a second tap can't
					// queue a duplicate request. Hermes rides this path now as well. 🪽
					disabled: !isRunning || editLoadingContainer === c.containerName,
					onClick: () => void openEditView(c),
					children: editLoadingContainer === c.containerName
						? html`<span class="flex items-center justify-center gap-1.5 opacity-70">⏳ Loading…</span>`
						: html`<span class="flex items-center justify-center gap-1.5">✏️ Edit</span>`,
				})}
			</span>
<!-- 🔑 Google API — same gating as the desktop row, full-width on mobile.
			     Disabled when stopped (matches Edit + the desktop Google button);
			     the wrapping <span> carries the tooltip so it still shows on tap. -->
			${gogEnabled ? html`
				<span title="${isRunning ? "" : "please start agent to connect Google"}" class="block w-full">
					${Button({
						variant: "outline",
						className: "glow-btn w-full",
						disabled: !isRunning,
						onClick: () => void openConnectGoogleView(c),
						children: html`<span class="flex items-center justify-center gap-1.5">
							<span class="w-2 h-2 rounded-full ${gogStatusByContainer.get(c.containerName)?.connected ? "bg-green-400" : "bg-gray-500"}"></span>
							🔑 Google API ${gogStatusByContainer.get(c.containerName)?.connected ? "✅" : ""}
						</span>`,
					})}
				</span>
			` : ""}
			<!-- 📱 WhatsApp — full-width on mobile. Same gating as Edit/Google. -->
			<span title="${isRunning ? "" : "please start agent to connect WhatsApp"}" class="block w-full">
				${Button({
					variant: "outline",
					className: "glow-btn w-full",
					disabled: !isRunning,
					onClick: () => void openConnectWhatsappView(c),
					children: html`<span class="flex items-center justify-center gap-1.5">
						<span class="w-2 h-2 rounded-full ${waStatusByContainer.get(c.containerName)?.connected ? "bg-green-400" : "bg-gray-500"}"></span>
						📱 WhatsApp ${waStatusByContainer.get(c.containerName)?.connected ? "✅" : ""}
					</span>`,
				})}
			</span>
			<span title="${isRunning ? "" : "backup is available only while running in v1"}" class="block w-full">
				${Button({
					variant: "outline",
					className: "glow-btn w-full",
					disabled: !isRunning || backupBusyContainer === c.containerName,
					onClick: () => void handleBackupClick(c),
					children: backupBusyContainer === c.containerName
						? html`<span class="flex items-center justify-center gap-1.5 opacity-70">⏳ Preparing backup…</span>`
						: html`<span class="flex items-center justify-center gap-1.5">📦 Backup</span>`,
				})}
			</span>
		</div>
	`;
};

// ============================================================================
// 🌱 Empty State — no containers yet? No problem.
// Friendly, inviting, "the void awaits your creation" energy 🌌
// ============================================================================
const renderEmptyState = () => html`
	<div class="flex flex-col items-center justify-center py-20 text-muted-foreground">
		<!-- 🐦 Woodpecker in the empty state — a friendly beacon in the void -->
		<div class="empty-state-icon mb-4 opacity-30">${woodpeckerSvg}</div>
		<p class="text-lg font-medium">No agent containers yet.</p>
		<p class="text-sm mt-1 opacity-70">Click "+ Create Agent" to deploy your first one.</p>
	</div>
`;

// ============================================================================
// 📊 Agents List — responsive! 🏆
// 📱 Mobile (<640px): stacked WhatsApp-style cards via renderCard.
// 💻 Desktop (≥640px): classic 5-column table via renderRow.
// Tailwind's `sm:` breakpoint toggles the two — only one is ever visible, so
// no layout-shift flicker during resize. Wrapped by the glow-border card in
// renderDashboard so both variants sit inside the same visual frame. ✨
// ============================================================================
const renderTable = () => html`
	<!-- 📱 Mobile: stacked cards, one per container, with divider lines -->
	<div class="sm:hidden flex flex-col divide-y divide-border/50">
		${containers.map(renderCard)}
	</div>

	<!-- 💻 Desktop: four-column table.
	     📐 We wrap the table in a div toggler instead of applying
	     hidden/sm:table directly on the table itself. Reason: relying on
	     Tailwind to flip a table element display between none and table
	     across a breakpoint was unreliable in practice (blank dashboard on
	     wide screens). hidden + sm:block on a wrapper div is a bog-standard
	     pattern and the inner table keeps its native display. -->
	<div class="hidden sm:block">
		<table class="w-full text-sm sci-fi-table">
			<thead>
				<tr class="border-b border-border/50 text-left">
					<th class="px-4 py-3 sci-fi-label">Agent</th>
					<th class="px-4 py-3 sci-fi-label">Status</th>
					<th class="px-4 py-3 sci-fi-label col-hours">Usage Hours</th>
					<th class="px-4 py-3 sci-fi-label">Actions</th>
				</tr>
			</thead>
			<tbody>
				${containers.map(renderRow)}
			</tbody>
		</table>
	</div>
`;

// ============================================================================
// 📊 Dashboard View — the main page with branding + table
// This is home base. Command central. The bridge of the starship. 🚀
// ============================================================================
// ⏳ Tiny loading row for the initial fetch — avoids flashing "empty" before data arrives.
const renderLoadingState = () => html`
	<div class="flex flex-col items-center justify-center py-20 text-muted-foreground">
		<p class="text-sm opacity-70">⏳ Loading containers from pektown-api…</p>
	</div>
`;

const renderDashboard = () => html`
	<div class="fade-in">
		${dashboardSuccessMessage ? html`
			<div class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-4 text-sm text-green-300 flex items-start justify-between gap-3">
				<div>${dashboardSuccessMessage}</div>
				<button class="text-green-300/70 hover:text-green-200" @click=${() => { dashboardSuccessMessage = null; renderApp(); }}>✕</button>
			</div>
		` : ""}
		<!-- 🏠 Section header — refresh + create button -->
		<div class="flex items-center justify-end gap-2 mb-4">
			<!-- 🔄 Manual refresh — handy while debugging, also re-fetches after actions -->
			${Button({
				variant: "outline",
				className: "glow-btn",
				disabled: isLoading,
				children: html`<span class="flex items-center gap-1.5">${isLoading ? "⏳" : "🔄"} Refresh</span>`,
				onClick: () => void loadContainers(),
			})}
			${Button({
				variant: "outline",
				className: "glow-btn",
				children: html`<span class="flex items-center gap-1.5">${icon(Upload, "sm")} Create from Backup</span>`,
				onClick: () => {
					if (!ensureActiveGoogleSession()) return;
					selectedBackupFile = null;
					backupNewAgentName = "";
					backupImportError = null;
					backupImportResult = null;
					currentView = "import-backup";
					renderApp();
				},
			})}
			${Button({
				className: "glow-btn",
				// 🧠 Create no longer needs to wait for /ai-models: new agents start
				// on the server-side PekTown OpenCode Go default. If the catalog is
				// still loading, the form opens immediately and the dropdowns hydrate
				// as soon as loadAiModels() resolves. No more spooky permanent
				// "Loading models…" button for freshly signed-in friends. 👻
				children: html`<span class="flex items-center gap-1.5">${icon(Plus, "sm")} Create Agent</span>`,
				onClick: () => {
					if (!ensureActiveGoogleSession()) return;
					if (aiModels.length === 0) void loadAiModels();
					currentView = "create";
					renderApp();
				},
			})}
		</div>

		<!-- 📊 Table card — glowing, hoverable, futuristic ✨ -->
		<div class="glow-border rounded-lg overflow-hidden bg-card">
			${isLoading && containers.length === 0
				? renderLoadingState()
				: containers.length > 0
					? renderTable()
					: renderEmptyState()}
		</div>

		<!-- 📡 Footer status bar — counts on the left, last error on the right -->
		<div class="mt-4 flex items-center justify-between text-xs text-muted-foreground/60">
			<span>${containers.length} container${containers.length !== 1 ? "s" : ""} registered · ${containers.filter(c => c.status === "running").length} active</span>
			${loadError
				? html`<span class="text-red-500/80">⚠️ ${loadError}</span>`
				: html`<span>🟢 connected to /api</span>`}
		</div>
	</div>
`;

// ============================================================================
// 📝 Create Agent View — full page form (no overlay dialogs here!)
// Replaces the dashboard view entirely. Back button takes you home.
// Labels are INLINE with fields — clean, compact, professional. 📐
// "To create is to give form to the void." — Some sci-fi book, probably
// ============================================================================
// ✅ Client-side validation — mirrors the server's rules so the user gets
// instant feedback instead of round-tripping for obvious mistakes. The API
// is still the source of truth; we just try not to bother it with junk.
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;
const validateForm = (f: FormState, isEdit: boolean): string | null => {
	// 🆕 Create: every field required. ✏️ Edit: telegram fields optional (blank =
	// keep current); AI key is ALWAYS required (form pre-fills it, so blank
	// here means the user deliberately cleared it). Agent name is REQUIRED
	// in both modes.
	if (!AGENT_NAME_RE.test(f.agentName)) return "Agent name must start with a letter/digit and use only letters, digits, _ or -.";
	if (f.telegramBotToken && !BOT_TOKEN_RE.test(f.telegramBotToken)) {
		return "Telegram bot token looks wrong — expected shape like 123456789:ABC...";
	}
	if (!isEdit || f.telegramUserIds.trim()) {
		const ids = f.telegramUserIds.split(",").map(s => s.trim()).filter(Boolean);
		if (ids.length === 0 || !ids.every(id => /^\d+$/.test(id))) {
			return "Telegram user IDs must be a comma-separated list of numeric IDs.";
		}
	}
	if (!isEdit) return null;
	const modelChanged = f.aiProvider !== editOriginalProvider || f.aiModel !== editOriginalModel;
	const keyTyped = f.aiApiKey.trim().length > 0;
	// 🧠 Edit path: only require the ai_models catalog when the user is actually
	// changing the brain. A flaky /ai-models fetch should NOT block a pure
	// rename, Telegram-token update, or key rotation. The server is still the
	// source of truth and validates aiModel whenever we send one.
	if (modelChanged) {
		const picked = aiModelById(f.aiModel);
		if (!picked) return "Models are still loading — wait a moment, then pick an AI model from the list.";
		if (picked.provider !== f.aiProvider) return "Selected model doesn't match the chosen provider.";
		if (!keyTyped && !editKeysPresent[f.aiProvider]) {
			return `Please enter a ${providerLabel(f.aiProvider)} API key — we don't have one saved for this provider yet.`;
		}
	}
	// 🚦 Edit requires AT LEAST ONE changed field — otherwise the submit is a
	// no-op that would still trigger a container restart. A typed (non-empty)
	// aiApiKey ALWAYS counts as a change, even if it happens to match what's
	// stored (the client can't know that without seeing the raw key, and
	// rotating to the "same" key is a no-op on the container side anyway).
	const anyChange = f.agentName !== editOriginalName
		|| f.telegramBotToken
		|| f.telegramUserIds.trim()
		|| keyTyped
		|| modelChanged;
	if (!anyChange) return "Nothing to save — change at least one field.";
	return null;
};

// 📌 Remembered original values from when we opened edit — let the validator
// tell "user changed X" apart from "user left X alone". Three fields because
// any of them counts as a change that warrants a server round-trip. (API key
// is tracked separately as "did the user type anything?" — we no longer
// pre-fill it or round-trip the raw value.)
let editOriginalName = "";
let editOriginalProvider = "openai";
let editOriginalModel = "gpt-5-mini";

// 🔑 Per-provider key presence for THIS edit session. Populated right before
// we switch to the edit view (the click handler awaits fetchAiKeysStatus).
// Used by validateForm and the form's hint text to decide whether an empty
// API-key input is OK ("we already have your key") or a blocker.
let editKeysPresent: AiKeyPresence = {};

// 🔔 One-shot toast for transient errors (mostly "couldn't open Edit"). Short
// and cheap — single message, auto-hides on the next user action or when the
// timer fires. No queueing; a second toast replaces the first.
let toastMessage: string | null = null;
let toastTimer: number | null = null;
const showErrorToast = (msg: string) => {
	toastMessage = msg;
	if (toastTimer !== null) clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => {
		toastMessage = null;
		toastTimer = null;
		renderApp();
	}, 5000); // 🕒 5 s — long enough to read a sentence, short enough to get out of the way
	renderApp();
};
const dismissToast = () => {
	if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
	toastMessage = null;
	renderApp();
};

// ⏳ Which container's Edit button is currently fetching its presence info?
// Non-null while the /ai-keys-status request is in flight — used to disable
// the row's Edit button (so a double-click doesn't fire twice) and show a
// subtle spinner label. Cleared on success or error.
let editLoadingContainer: string | null = null;

// ============================================================================
// 🎮 Google Workspace Connect — view openers + handlers
// ============================================================================

// 📡 Fetch /google/status for every container in parallel, populate the cache,
// and re-render so the row badges paint. Called right after loadContainers and
// after returning from the Connect screen. If the very first response is 503,
// we set gogEnabled=false (host has no OAuth client configured) and abort the
// rest — no point polling something that's not provisioned.
const refreshGoogleStatuses = async (): Promise<void> => {
	if (!gogEnabled || containers.length === 0) return;
	// 🚀 Fire all in parallel; the per-container cache update + re-render
	// happens as each one resolves. Failures are swallowed (badge stays at
	// whatever it was — silent degradation is fine here).
	await Promise.all(containers.map(async (c) => {
		gogStatusFetching.add(c.containerName);
		try {
			const s = await fetchGoogleStatus(c.containerName);
			if (s === "disabled") {
				// 🛑 Site-wide kill switch — if pektown-api isn't set up for gog,
				// hide the whole feature instead of decorating every row with a
				// broken button. Clear the cache so we don't paint stale state.
				gogEnabled = false;
				gogStatusByContainer.clear();
				return;
			}
			gogStatusByContainer.set(c.containerName, s);
		} catch {
			// 🤫 Per-row fetch failure — keep last-known state, don't toast.
			// The user finds out by clicking Connect Google and seeing the error.
		} finally {
			gogStatusFetching.delete(c.containerName);
		}
	}));
	renderApp();
};

// 🎯 Open the Connect Google screen for a container. Resets all connect-flow
// state, fetches the current status, then flips currentView. Mirrors the
// shape of openEditView but doesn't need a pre-fetch we can't recover from
// (we render the screen even if the status fetch fails — the user can still
// kick off a fresh connect).
const openConnectGoogleView = async (c: Container): Promise<void> => {
	connectContainer = { containerName: c.containerName, agentName: c.agentName, runtime: c.runtime };
	connectEmail = "";
	connectAuthUrl = null;
	connectRedirectUrl = "";
	connectError = null;
	connectInFlight = null;
	connectStatus = null;
	currentView = "connect-google";
	renderApp();
	// 🛰️ Best-effort status fetch. On failure, render as "unknown" — the
	// Connect form still works.
	try {
		connectStatus = await fetchGoogleStatus(c.containerName);
		if (connectStatus === "disabled") {
			gogEnabled = false;
			showErrorToast("Google integration isn't configured on this host (missing OAuth client).");
			currentView = "dashboard";
			connectContainer = null;
		}
	} catch (err) {
		connectError = `Couldn't load status: ${(err as Error).message}`;
	}
	renderApp();
};

// 🔗 Step 1 — mint an auth URL. We pass the typed email through so gog can
// pre-fill Google's account picker (login_hint baked into the URL by gog's
// --remote --step 1 logic).
const handleGetAuthLink = async (): Promise<void> => {
	if (!connectContainer || connectInFlight) return;
	const email = connectEmail.trim();
	// 🧪 Loose client-side check (server validates again). Catches obvious
	// typos ("gmail.com" missing the @) before a wasted round-trip.
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		connectError = "Enter a valid email address (e.g. you@gmail.com).";
		renderApp();
		return;
	}
	connectError = null;
	connectInFlight = "step1";
	renderApp();
	try {
		const { authUrl } = await googleConnectStep1(connectContainer.containerName, email);
		connectAuthUrl = authUrl;
	} catch (err) {
		connectError = (err as Error).message;
	} finally {
		connectInFlight = null;
		renderApp();
	}
};

// 🎟️ Step 2 — exchange the pasted redirect URL for a refresh token. On
// success, gog has written the token to the keyring AND pektown-api has
// patched openclaw.json + restarted the container. We refresh the status
// list so the new account shows up immediately and clear the step-2 inputs
// (the user may want to connect another account next).
const handleConnect = async (): Promise<void> => {
	if (!connectContainer || connectInFlight) return;
	const email = connectEmail.trim();
	const url = connectRedirectUrl.trim();
	// 🧪 The pasted URL must contain a `code=` query param — gog parses it
	// out. Catching it here gives a faster + clearer error than letting the
	// server bounce a malformed paste.
	if (!url.includes("code=")) {
		connectError = "That doesn't look like the redirect URL. It should contain code=… in the address.";
		renderApp();
		return;
	}
	connectError = null;
	connectInFlight = "step2";
	renderApp();
	try {
		await googleConnectStep2(connectContainer.containerName, email, url);
		// ♻️ Reset step-1+2 inputs so the page is ready for another account.
		connectEmail = "";
		connectAuthUrl = null;
		connectRedirectUrl = "";
		// 🔄 Refresh the connected-accounts list so the user sees the new entry.
		try {
			const fresh = await fetchGoogleStatus(connectContainer.containerName);
			if (fresh !== "disabled") {
				connectStatus = fresh;
				gogStatusByContainer.set(connectContainer.containerName, fresh);
			}
		} catch { /* 🤫 stale list is fine; back-nav will refresh */ }
	} catch (err) {
		connectError = (err as Error).message;
	} finally {
		connectInFlight = null;
		renderApp();
	}
};

// 🚪 Disconnect a single email. We confirm() before the network call —
// disconnect is destructive (revokes the refresh token), and we don't want
// a double-click to wipe a working integration.
const handleDisconnect = async (email: string): Promise<void> => {
	if (!connectContainer || connectInFlight) return;
	if (!window.confirm(`Disconnect ${email} from this agent? You can reconnect later, but the agent will lose Google access until then.`)) return;
	connectError = null;
	connectInFlight = email;
	renderApp();
	try {
		await googleDisconnect(connectContainer.containerName, email);
		const fresh = await fetchGoogleStatus(connectContainer.containerName);
		if (fresh !== "disabled") {
			connectStatus = fresh;
			gogStatusByContainer.set(connectContainer.containerName, fresh);
		}
	} catch (err) {
		connectError = (err as Error).message;
	} finally {
		connectInFlight = null;
		renderApp();
	}
};

// ============================================================================
// 📱 WhatsApp Connect — view openers + handlers
// ============================================================================

// 📡 One-shot per-container WhatsApp status fetch. Unlike the Google
// equivalent, this only runs ONCE per page load (and again when the user
// returns from the Connect-WhatsApp screen) — status changes rarely, so
// per-poll-tick fan-out would be wasted docker exec calls.
const refreshWhatsappStatuses = async (): Promise<void> => {
	if (containers.length === 0) return;
	await Promise.all(containers.map(async (c) => {
		try {
			const s = await fetchWhatsappStatus(c.containerName);
			waStatusByContainer.set(c.containerName, s);
		} catch {
			// 🤫 Per-row failure — keep last-known state (or empty), don't toast.
		}
	}));
	renderApp();
};

// 🔁 Tear down the active poll loop (idempotent).
const stopWaPolling = () => {
	if (waPollHandle !== null) {
		clearInterval(waPollHandle);
		waPollHandle = null;
	}
};

// 🔁 Spin up the 3 s status poll while the Connect-WhatsApp screen is open.
// Tick re-fetches /whatsapp/status, updates `waState` (so the QR canvas
// re-renders if qrSeq changed, or the success view shows up on
// connected:true), and self-stops on connected/error/screen-close.
const startWaPolling = () => {
	stopWaPolling();
	waPollHandle = window.setInterval(async () => {
		if (currentView !== "connect-whatsapp" || !connectWhatsappContainer) {
			stopWaPolling();
			return;
		}
		try {
			const s = await fetchWhatsappStatus(connectWhatsappContainer.containerName);
			waState = s;
			if (s.connected || s.error) stopWaPolling();
			renderApp();
		} catch {
			// 🤫 Transient fetch error — keep polling; the user can also click
			// Try Again. We don't surface every blip as a toast.
		}
	}, 3000);
};

const disconnectOtherWhatsappAgentBeforeConnecting = async (target: Container): Promise<boolean> => {
	// 📵 Product rule: one WhatsApp account ↔ one active agent. Before starting
	// a new QR flow, do a fresh status sweep and warn the user if another agent
	// is currently linked. If they agree, disconnect the old one first so the new
	// link doesn't fight a cloned/live Baileys session. Calm UX, fewer ghosts. 👻
	await Promise.all(containers.map(async (candidate) => {
		try { waStatusByContainer.set(candidate.containerName, await fetchWhatsappStatus(candidate.containerName)); }
		catch { /* keep any last-known value */ }
	}));
	const targetStatus = waStatusByContainer.get(target.containerName);
	if (targetStatus?.connected) return true;

	const existing = containers.find((candidate) =>
		candidate.containerName !== target.containerName &&
		waStatusByContainer.get(candidate.containerName)?.connected === true,
	);
	if (!existing) return true;

	const ok = window.confirm(
		`WhatsApp is already connected to ${existing.agentName}.\n\n` +
		`To connect WhatsApp to ${target.agentName}, the existing WhatsApp connection of ${existing.agentName} will be disconnected.\n\n` +
		`Continue?`,
	);
	if (!ok) return false;

	waStatusByContainer.set(existing.containerName, { connected: false });
	renderApp();
	try {
		await whatsappLogout(existing.containerName);
		waStatusByContainer.set(existing.containerName, { connected: false });
		return true;
	} catch (err) {
		showErrorToast(`Couldn't disconnect WhatsApp from ${existing.agentName}: ${(err as Error).message}`);
		try { waStatusByContainer.set(existing.containerName, await fetchWhatsappStatus(existing.containerName)); } catch {}
		return false;
	}
};

// 🎯 Open the Connect-WhatsApp screen for a container. Resets state, fetches
// status, kicks off the helper if not already connected, starts polling.
const openConnectWhatsappView = async (c: Container): Promise<void> => {
	if (!(await disconnectOtherWhatsappAgentBeforeConnecting(c))) return;
	connectWhatsappContainer = { containerName: c.containerName, agentName: c.agentName };
	waState = null;
	waInFlight = null;
	waError = null;
	waJustLoggedOut = false; // 🧹 fresh open — no stale logout banner from a previous visit
	stopWaPolling();
	currentView = "connect-whatsapp";
	renderApp();

	// 1️⃣ Status check first — if already linked, render the success/logged-in
	// view immediately, no helper spawn. Otherwise fall through to /login.
	try {
		const s = await fetchWhatsappStatus(c.containerName);
		if (s.connected) {
			waState = s;
			renderApp();
			return; // 🚫 No polling needed when already connected.
		}
		// 🧹 Stale state.json from a previous timed-out login still says
		// {error:"timeout"} on disk until the helper rewrites it. Don't paint
		// it — we're about to POST /login which will overwrite it within ~1s.
		// Showing the expired card for that flicker just confuses the user
		// ("why does it say expired when I just opened it?"). Hold the
		// "Checking…" spinner instead by leaving waState null.
		waState = s.error ? null : s;
	} catch (err) {
		waError = `Couldn't load status: ${(err as Error).message}`;
		renderApp();
		return;
	}

	// 2️⃣ Not connected — kick off the helper login. The POST returns the
	// first QR (or { pending:true } if the helper is still spinning up).
	waInFlight = "login";
	renderApp();
	try {
		const s = await startWhatsappLogin(c.containerName);
		waState = s;
	} catch (err) {
		waError = (err as Error).message;
	} finally {
		waInFlight = null;
		renderApp();
	}

	// 3️⃣ Begin the 3 s poll loop. Self-stops on connected/error.
	startWaPolling();
};

// 🔁 "Try again" button — resets error state and re-runs the login spawn.
const handleStartWaLogin = async (): Promise<void> => {
	if (!connectWhatsappContainer || waInFlight) return;
	waError = null;
	waInFlight = "login";
	renderApp();
	try {
		const s = await startWhatsappLogin(connectWhatsappContainer.containerName);
		waState = s;
	} catch (err) {
		waError = (err as Error).message;
	} finally {
		waInFlight = null;
		renderApp();
	}
	if (waState && !waState.connected && !waState.error) startWaPolling();
};

// 🚪 Logout button on the Connect-WhatsApp screen.
//
// UX rule: logout should feel instant. No browser confirm(), no long
// hourglass, no surprise "Generating QR code…" after the user just asked to
// disconnect. We optimistically flip the dashboard badge gray and navigate
// back immediately, while pektown-api finishes the slower WhatsApp/device
// cleanup in the background. If that background call fails, we show a toast on
// the dashboard — but we still do not trap the user on a spinner page. 🛟
const handleWaLogout = async (): Promise<void> => {
	// 🛑 Guard: no open container target, OR another action (login/logout)
	// is already in flight. Double-clicks should be boring, not noisy.
	if (!connectWhatsappContainer || waInFlight) return;

	const containerName = connectWhatsappContainer.containerName;

	// 🧹 Stop QR/status polling first. Otherwise a late poll can repaint the
	// connect screen while we're navigating away and briefly show the wrong
	// "Generating QR" state. The user asked to leave; we honor that. 👋
	stopWaPolling();
	waError = null;
	waInFlight = "logout";

	// ⚡ Optimistic local truth: for dashboard UX, this row is now disconnected.
	// The API route also writes state.json={connected:false} immediately, so a
	// later full refresh should agree with this cache within a moment.
	waStatusByContainer.set(containerName, { connected: false });

	// 🏠 Snap back to the dashboard now. No alert box, no waiting room.
	currentView = "dashboard";
	connectWhatsappContainer = null;
	waState = null;
	waJustLoggedOut = false;
	renderApp();

	// 🧵 Fire-and-report: let pektown-api do the real unlink/restart cleanup.
	// We intentionally don't await before navigating. If it fails, tell the
	// human in a toast and refresh this one badge from the server's latest view.
	void whatsappLogout(containerName)
		.then(() => {
			waStatusByContainer.set(containerName, { connected: false });
			renderApp();
		})
		.catch((err) => {
			showErrorToast(`WhatsApp logout may not have completed: ${(err as Error).message}`);
			void fetchWhatsappStatus(containerName)
				.then((s) => { waStatusByContainer.set(containerName, s); renderApp(); })
				.catch(() => { /* keep optimistic gray dot; user can refresh */ });
		})
		.finally(() => {
			waInFlight = null;
		});
};

// 🔄 "Reconnect" button on the freshly-logged-out card. Resets the just-
// logged-out flag and kicks off a brand-new QR-login flow without making
// the user navigate back to the dashboard and re-click 📱 WhatsApp.
const handleWaReconnect = async (): Promise<void> => {
	if (!connectWhatsappContainer || waInFlight) return;
	waJustLoggedOut = false;
	waState = null;
	waError = null;
	renderApp();
	// 🚀 Same login path the auto-open flow uses — spawns a detached helper,
	// polls state.json for the first QR, then 3s status poll takes over.
	await handleStartWaLogin();
};

// ✏️ Open the Edit Agent view for a given container. This is a two-step
// dance: first we hit /ai-keys-status for the container (so we know which
// providers already have a key in openclaw.json), then we flip to the edit
// view with the form pre-seeded. The API-key field is ALWAYS blank; the
// placeholder + hint text change based on whether the selected provider
// already has a saved key. If the status fetch fails (container gone,
// server hiccup) we bail with an error toast and stay on the dashboard —
// the user can try again or pick a different container.
const openEditView = async (c: Container): Promise<void> => {
	if (editLoadingContainer) return; // 🚫 another Edit is already loading
	editLoadingContainer = c.containerName;
	renderApp();

	let keys: AiKeyPresence;
	try {
		keys = await fetchAiKeysStatus(c.containerName);
	} catch (err) {
		// 💥 Couldn't read the container's config — surface it to the user
		// as a toast and stay on the dashboard (no half-opened form).
		showErrorToast(`Couldn't open Edit: ${(err as Error).message}`);
		editLoadingContainer = null;
		renderApp();
		return;
	}
	editLoadingContainer = null;

	editingContainer = { containerName: c.containerName, agentName: c.agentName, runtime: c.runtime };
	editKeysPresent = keys;
	// 🧠 Fall back gracefully if the container hasn't been backfilled yet —
	// use the UI's usual default so the dropdowns render something sensible.
	const defaults = defaultFormAiFields();
	const provider = c.aiProvider ?? defaults.aiProvider;
	const model    = c.aiModel    ?? defaults.aiModel;
	formData = {
		runtime: c.runtime,
		agentName: c.agentName,
		telegramBotToken: "",
		telegramUserIds: "",
		aiProvider: provider,
		aiModel:    model,
		aiApiKey:   "", // 🔑 always blank — user either leaves it (carry forward) or types new
	};
	editOriginalName     = formData.agentName;
	editOriginalProvider = formData.aiProvider;
	editOriginalModel    = formData.aiModel;
	formError = null;
	currentView = "edit";
	renderApp();
};

// 🚀 Submit handler — validates, POSTs to /api/containers/claim, then:
//   on success → reset form, return to dashboard, refresh list
//   on failure → stash the error + re-render (keep the form + inputs intact)
const submitCreateForm = async () => {
	const isEdit = currentView === "edit" && editingContainer !== null;
	const validationErr = validateForm(formData, isEdit);
	if (validationErr) { formError = validationErr; renderApp(); return; }
	isSubmittingForm = true;
	formError = null;
	renderApp();
	try {
		if (isEdit && editingContainer) {
			// ✏️ Only ship fields the user actually changed. API-key rules:
			//   • user typed something → send it (rotate the key)
			//   • field left blank + model changed → don't send aiApiKey; the
			//     server-side EDIT_PATCH_SCRIPT carries the target provider's
			//     existing key forward from openclaw.json. The validator has
			//     already confirmed that key exists (editKeysPresent check).
			const patch: Partial<FormState> = {};
			if (formData.agentName !== editOriginalName) patch.agentName = formData.agentName;
			if (formData.telegramBotToken) patch.telegramBotToken = formData.telegramBotToken;
			if (formData.telegramUserIds.trim()) patch.telegramUserIds = formData.telegramUserIds;
			const modelChanged = formData.aiModel !== editOriginalModel || formData.aiProvider !== editOriginalProvider;
			if (modelChanged) patch.aiModel = formData.aiModel;
			if (formData.aiApiKey.trim()) patch.aiApiKey = formData.aiApiKey;
			await patchContainer(editingContainer.containerName, patch);
			editingContainer = null;
		} else {
			await claimContainer(formData);
		}
		formData = emptyForm();
		currentView = "dashboard";
		await loadContainers(); // 📋 changes show up immediately
	} catch (err) {
		formError = (err as Error).message;
	} finally {
		isSubmittingForm = false;
		renderApp();
	}
};

const renderCreateView = () => {
	// ✏️ One view, two modes. Everything below keys off isEdit — header, input
	// disabled state, placeholders, submit button label. Keeps the UX truly
	// identical except for the header swap, as the user asked for.
	const isEdit = currentView === "edit" && editingContainer !== null;
	return html`
	<div class="fade-in">
		<!-- 🔙 Back button — hover slides it left, nice touch 👌 -->
		<button
			class="back-btn flex items-center gap-2 text-sm text-muted-foreground mb-6 bg-transparent border-none cursor-pointer p-0"
			@click=${() => {
				currentView = "dashboard";
				editingContainer = null;
				formData = emptyForm();
				formError = null;
				renderApp();
			}}
		>
			${icon(ArrowLeft, "sm")}
			<span>Back to Dashboard</span>
		</button>

		<!-- 📝 Form card — same glow treatment as the table -->
		<div class="glow-border rounded-lg bg-card p-8 max-w-3xl">
			<h2 class="text-xl font-bold tracking-tight mb-1">${isEdit ? "Edit Agent" : "Create Agent Container"}</h2>
			<p class="text-sm text-muted-foreground mb-8">${isEdit ? "Update this agent's settings" : "Deploy a new agent to the fleet"}</p>

			<hr class="sci-fi-divider mb-8" />

			<!-- 📝 Form fields — inline layout: label left, field right.
			     All fields are REQUIRED because /api/containers/claim validates
			     every one of them server-side. -->
			<div>
				${!isEdit ? html`
					<!-- 🧬 Runtime selector — OpenClaw is the legacy default; Hermes claims
					     warm hm_* pool containers and starts on PekTown OpenCode Go. -->
					<div class="form-row">
						<label class="form-label sci-fi-label">Runtime</label>
						<div class="form-field">
							${Select({
								value: formData.runtime,
								options: [
									{ value: "openclaw", label: "OpenClaw" },
									{ value: "hermes", label: "Hermes" },
								],
								disabled: isSubmittingForm,
								onChange: (value) => {
									formData.runtime = value as AgentRuntime;
									if (formData.runtime === "hermes") forceHermesV1AiFields();
									renderApp();
								},
							})}
							${formData.runtime === "hermes" ? html`<p class="text-xs text-muted-foreground mt-1.5">🪽 Hermes starts on PekTown OpenCode Go. WhatsApp and Google Workspace connect later.</p>` : ""}
						</div>
					</div>
				` : ""}

				<!-- 🏷️ Agent name — also used as the .claimed marker on the host,
				     so we keep it filesystem-safe (letters, digits, _, -). -->
				<div class="form-row">
					<label class="form-label sci-fi-label">Agent name</label>
					<div class="form-field">
						${Input({
							type: "text",
							placeholder: "my-agent",
							value: formData.agentName,
							// ✏️ Rename is supported — agent_name lives in Postgres,
							// so it's a pure DB update with no gateway restart.
							disabled: isSubmittingForm,
							onInput: (e) => { formData.agentName = (e.target as HTMLInputElement).value; },
						})}
					</div>
				</div>

				<!-- 🤖 Telegram bot token — validated server-side via Telegram getMe
				     before any config is touched. Required. -->
				<div class="form-row">
					<label class="form-label sci-fi-label">Telegram bot token</label>
					<div class="form-field">
						${Input({
							type: "password",
							placeholder: isEdit ? "Leave blank to keep current token" : "123456789:ABC... (from @BotFather)",
							value: formData.telegramBotToken,
							disabled: isSubmittingForm,
							onInput: (e) => { formData.telegramBotToken = (e.target as HTMLInputElement).value; },
						})}
					</div>
				</div>

				<!-- 👥 Telegram user IDs — the bouncer list. 🛡️ Only these IDs can
				     DM the bot. Comma-separated numeric IDs. -->
				<div class="form-row">
					<label class="form-label sci-fi-label">Telegram user IDs</label>
					<div class="form-field">
						${Input({
							type: "text",
							placeholder: isEdit ? "Leave blank to keep current allowlist" : "123456789, 987654321",
							value: formData.telegramUserIds,
							disabled: isSubmittingForm,
							onInput: (e) => { formData.telegramUserIds = (e.target as HTMLInputElement).value; },
						})}
					</div>
				</div>

				<!-- ✂️ Visual break between comms config and AI config -->
				<hr class="sci-fi-divider mt-8 mb-2" />
				${!isEdit ? html`
					<div class="mt-4 px-4 py-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-500">
						🧠 New agents use OpenCode Go by default. You can change provider/model or paste your own key later from Edit.
					</div>
				` : html`

				<!-- 🧠 AI provider — picks the vendor (OpenAI, Anthropic, …).
				     Changing this filters the model dropdown below and clears
				     the API key field (keys aren't portable across providers). -->
				<div class="form-row">
					<label class="form-label sci-fi-label">AI provider</label>
					<div class="form-field">
						${Select({
							value: formData.aiProvider,
							options: providerOptions(),
							disabled: isSubmittingForm || (!isEdit && formData.runtime === "hermes"),
							onChange: (value) => {
								if (value === formData.aiProvider) return;
								formData.aiProvider = value;
								// 🔄 Snap aiModel to the first model under the new
								// provider so the dependent dropdown is never
								// stranded on an unrelated id.
								const firstForProvider = aiModels.find((m) => m.provider === value);
								formData.aiModel = firstForProvider?.id ?? "";
								// 🔑 Clear any freshly-typed key when the provider
								// changes — keys aren't portable across providers.
								// If the new provider already has a key stored
								// server-side (editKeysPresent), leaving the field
								// blank is fine and the validator will allow save;
								// otherwise the hint below prompts for one.
								formData.aiApiKey = "";
								renderApp();
							},
						})}
					</div>
				</div>

				<!-- 🧠 AI model — dependent dropdown filtered to the chosen
				     provider. The picked value determines which model string
				     the API writes into openclaw.json. -->
				<div class="form-row">
					<label class="form-label sci-fi-label">AI model</label>
					<div class="form-field">
						${Select({
							value: formData.aiModel,
							options: modelOptionsFor(formData.aiProvider),
							disabled: isSubmittingForm || (!isEdit && formData.runtime === "hermes"),
							// 🔁 Re-render so the Select trigger shows the newly picked model —
							// mini-lit's Select captures `selectedOption` from props at render time
							// and doesn't reactively update on its own, so without renderApp() the
							// label stays stuck on whatever was first painted. 🙈
							onChange: (value) => { formData.aiModel = value; renderApp(); },
						})}
					</div>
				</div>

				<!-- 🔑 API key — label + placeholder reflect the selected
				     provider. ALWAYS blank on render; we never round-trip the
				     raw key to the browser. Behaviour splits on mode + saved
				     state (Create / Edit × key saved? × key typed?):
				       • Create: required — placeholder shows the expected prefix.
				       • Edit + saved for this provider + empty: "✓ Saved — leave blank to keep, or paste a new one to rotate."
				       • Edit + NOT saved for this provider: same amber hint as before, save blocked by validator.
				       • Edit + user typed something: no hint, we treat it as a rotation. -->
				<div class="form-row">
					<label class="form-label sci-fi-label">${providerLabel(formData.aiProvider)} API key</label>
					<div class="form-field">
						${Input({
							type: "password",
							placeholder: (isEdit && editKeysPresent[formData.aiProvider])
								? "Saved — leave blank to keep, paste to rotate"
								: keyPlaceholderFor(formData.aiProvider),
							value: formData.aiApiKey,
							disabled: isSubmittingForm,
							onInput: (e) => { formData.aiApiKey = (e.target as HTMLInputElement).value; renderApp(); },
						})}
						${(() => {
							const typed = formData.aiApiKey.trim().length > 0;
							if (typed) return ""; // ✍️ user is actively typing; no hint needed
							if (!isEdit) {
								// 🆕 Create: always needs a key — friendly amber nudge.
								return html`<p class="text-xs text-amber-500/80 mt-1.5">💡 Please add a ${providerLabel(formData.aiProvider)} API key to save changes.</p>`;
							}
							// ✏️ Edit path
							if (editKeysPresent[formData.aiProvider]) {
								// ✅ Saved key exists — blank input means "reuse it". Green, reassuring.
								return html`<p class="text-xs text-emerald-500/80 mt-1.5">✅ We already have a ${providerLabel(formData.aiProvider)} key saved. Leave blank to keep it, or paste a new one to rotate.</p>`;
							}
							// ⚠️ Switched to a provider we've never configured — user must paste a key.
							return html`<p class="text-xs text-amber-500/80 mt-1.5">💡 No ${providerLabel(formData.aiProvider)} key saved yet — please paste one to save changes.</p>`;
						})()}
					</div>
				</div>

				`}

				<!-- ⚠️ Error banner — shows client-side validation failures AND
				     any 4xx/5xx the API returned, with its detail text. -->
				${formError ? html`
					<div class="mt-6 px-4 py-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-500">
						⚠️ ${formError}
					</div>
				` : ""}

				<!-- 🎬 Action buttons — right-aligned, generous top spacing -->
				<div class="flex justify-end gap-3 mt-10">
					${Button({
						variant: "outline",
						className: "glow-btn",
						disabled: isSubmittingForm,
						children: "Cancel",
						onClick: () => {
							currentView = "dashboard";
							editingContainer = null;
							formData = emptyForm();
							formError = null;
							renderApp();
						},
					})}
					${Button({
						className: "glow-btn",
						disabled: isSubmittingForm,
						children: isSubmittingForm
							? html`<span class="flex items-center gap-1.5 opacity-70">⏳ ${isEdit ? "Saving" : "Deploying"}…</span>`
							: isEdit
								? html`<span class="flex items-center gap-1.5">💾 Save Changes</span>`
								: html`<span class="flex items-center gap-1.5">${icon(Plus, "sm")} Create Agent</span>`,
						onClick: () => void submitCreateForm(),
					})}
				</div>

				${isEdit && editingContainer ? html`
					<!-- 🗑️ Danger zone lives at the END of Edit, not on the dashboard row.
					     That keeps destructive actions away from casual Start/Edit/Connect
					     clicks while still making cleanup discoverable when managing an agent. -->
					<div class="mt-10 rounded-md border border-red-500/30 bg-red-500/10 p-4">
						<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
							<div>
								<div class="font-medium text-red-400">🗑️ Danger zone</div>
								<p class="text-xs text-muted-foreground mt-1">Clean delete removes the Docker container, DB row, and mounted files after typed confirmation.</p>
							</div>
							${Button({
								variant: "outline",
								className: "glow-btn text-red-500/90",
								onClick: () => {
									const live = containers.find((c) => c.containerName === editingContainer.containerName);
									openDeleteView(live ?? {
										containerName: editingContainer.containerName,
										agentName: editingContainer.agentName,
										runtime: editingContainer.runtime,
										status: "running",
										currentRunHours: 0,
										totalHours: 0,
										aiProvider: null,
										aiModel: null,
										aiModelName: null,
										aiApiKeySet: false,
										aiCredentialSource: "unknown",
									});
								},
								children: html`<span class="flex items-center gap-1.5">${icon(Trash2, "xs")} Clean delete agent</span>`,
							})}
						</div>
					</div>
				` : ""}
			</div>
		</div>
	</div>
`;
};

// ============================================================================
// ✨ Create from Backup View — upload a PekTown bundle and restore it as a NEW
// agent/container. This is intentionally a full-page flow (not a tiny modal)
// because backups deserve calm hands and big obvious buttons. 📦
// ============================================================================
const renderImportBackupView = () => html`
	<div class="max-w-2xl mx-auto fade-in">
		<button class="mb-4 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors" @click=${() => { currentView = "dashboard"; renderApp(); }}>
			${icon(ArrowLeft, "sm")} Back to dashboard
		</button>
		<div class="glow-border rounded-lg bg-card p-6 space-y-5">
			<div>
				<h2 class="text-xl font-semibold mb-1">✨ Create agent from backup</h2>
				<p class="text-sm text-muted-foreground">Upload a PekTown backup bundle. Restore always creates a new agent name and new container.</p>
			</div>
			<div class="space-y-2">
				<label class="text-sm font-medium">Backup file</label>
				<input class="block w-full text-sm" type="file" accept=".gz,.tgz,.tar.gz" @change=${(e: Event) => {
					selectedBackupFile = ((e.target as HTMLInputElement).files ?? [])[0] ?? null;
					backupImportError = null;
					renderApp();
				}} />
				${selectedBackupFile ? html`<p class="text-xs text-muted-foreground">📦 ${selectedBackupFile.name} · ${(selectedBackupFile.size / 1024 / 1024).toFixed(2)} MB</p>` : ""}
			</div>
			<div class="space-y-2">
				<label class="text-sm font-medium">New agent name</label>
				${Input({
					value: backupNewAgentName,
					placeholder: "support-copy",
					// 🔓 The submit button's disabled state depends on this value, so
					// re-render as the user types. Without this, the variable updates but
					// the button stays visually disabled until some unrelated render happens.
					onInput: (e: Event) => { backupNewAgentName = (e.target as HTMLInputElement).value; renderApp(); },
				})}
			</div>
			${backupImportError ? html`<div class="text-sm text-red-500">⚠️ ${backupImportError}</div>` : ""}
			${backupImportResult ? html`
				<div class="rounded-md border border-green-500/30 bg-green-500/10 p-4 text-sm space-y-1">
					<div class="font-medium text-green-400">New agent created 🎉</div>
					<div>Container: <span class="font-mono">${backupImportResult.container}</span></div>
					<div>Runtime: ${backupImportResult.runtime === "hermes" ? "🪽 Hermes" : "🦀 OpenClaw"}</div>
					<div>Google: ${backupImportResult.integrationStatus?.google === "connected" ? "connected ✅" : "reconnect required 🔁"}</div>
					<div>WhatsApp: ${backupImportResult.integrationStatus?.whatsapp === "connected" ? "connected ✅" : "reconnect required 🔁"}</div>
				</div>
			` : ""}
			<div class="flex justify-end gap-2">
				${Button({ variant: "outline", className: "glow-btn", children: "Cancel", onClick: () => { currentView = "dashboard"; renderApp(); } })}
				${Button({
					className: "glow-btn",
					disabled: !selectedBackupFile || !backupNewAgentName.trim() || isImportingBackup,
					children: isImportingBackup ? "⏳ Restoring…" : "✨ Create new agent",
					onClick: async () => {
						if (!selectedBackupFile) return;
						isImportingBackup = true;
						backupImportError = null;
						backupImportResult = null;
						renderApp();
						try {
							backupImportResult = await importBackupAsAgent(selectedBackupFile, backupNewAgentName.trim());
							const readyAgentName = backupImportResult.customer || backupNewAgentName.trim();
							dashboardSuccessMessage = `✅ ${readyAgentName} is ready`;
							selectedBackupFile = null;
							backupNewAgentName = "";
							currentView = "dashboard";
							await loadContainers();
						} catch (err) {
							backupImportError = (err as Error).message;
						} finally {
							isImportingBackup = false;
							renderApp();
						}
					},
				})}
			</div>
		</div>
	</div>
`;

const renderDeleteAgentView = () => {
	const c = deletingContainer;
	if (!c) return renderDashboard();
	const phrase = `DELETE ${c.agentName}`;
	const confirmed = deleteConfirmText === phrase;
	return html`
		<div class="max-w-2xl mx-auto fade-in">
			<button class="mb-4 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors" @click=${() => { currentView = "dashboard"; renderApp(); }}>
				${icon(ArrowLeft, "sm")} Back to dashboard
			</button>
			<div class="glow-border rounded-lg bg-card p-6 space-y-5 border-red-500/30">
				<div>
					<h2 class="text-xl font-semibold mb-1 text-red-400">🗑️ Clean delete ${c.agentName}</h2>
					<p class="text-sm text-muted-foreground">This removes the Docker container, PekTown DB row, and mounted customer files. Download a backup first if you may need this agent again.</p>
				</div>
				<div class="rounded-md bg-red-500/10 border border-red-500/30 p-4 text-sm space-y-1">
					<div>✅ Docker container <span class="font-mono">${c.containerName}</span></div>
					<div>✅ Database ownership row</div>
					<div>✅ Mounted files under customers/${c.containerName}</div>
				</div>
				${Button({ variant: "outline", className: "glow-btn", disabled: c.status !== "running" || backupBusyContainer === c.containerName, onClick: () => void handleBackupClick(c), children: "📦 Download backup first" })}
				<div class="space-y-2">
					<label class="text-sm font-medium">Type <span class="font-mono text-red-400">${phrase}</span> to continue</label>
					${Input({ value: deleteConfirmText, placeholder: phrase, onInput: (e: Event) => { deleteConfirmText = (e.target as HTMLInputElement).value; renderApp(); } })}
				</div>
				<div class="flex justify-end gap-2">
					${Button({ variant: "outline", className: "glow-btn", children: "Cancel", onClick: () => { currentView = "dashboard"; renderApp(); } })}
					${Button({
						className: "glow-btn bg-red-600 hover:bg-red-700",
						disabled: !confirmed || isDeletingContainer,
						children: isDeletingContainer ? "⏳ Deleting…" : "Delete permanently",
						onClick: async () => {
							isDeletingContainer = true;
							loadError = null;
							renderApp();
							try {
								await cleanDeleteContainer(c.containerName, true);
								currentView = "dashboard";
								deletingContainer = null;
								await loadContainers();
							} catch (err) {
								loadError = (err as Error).message;
							} finally {
								isDeletingContainer = false;
								renderApp();
							}
						},
					})}
				</div>
			</div>
		</div>
	`;
};

// ============================================================================
// 🎮 Connect Google View — full-page screen, mirrors renderCreateView.
// Two stacked steps: (1) email + Get auth link, (2) paste redirect URL +
// Connect. Step 2 hides until step 1 succeeds. Bottom of the page lists
// any already-connected accounts with a Disconnect button each.
// ============================================================================
const renderConnectGoogleView = () => {
	if (!connectContainer) {
		// 🛟 Defensive: if we somehow landed on this view with no target,
		// snap back to the dashboard rather than rendering a half-empty page.
		currentView = "dashboard";
		return renderDashboard();
	}
	const c = connectContainer;
	const isHermesGoogle = c.runtime === "hermes";
	const accounts = (connectStatus && connectStatus !== "disabled") ? connectStatus.accounts : [];
	const isFetchingStatus = connectStatus === null;

	return html`
	<div class="fade-in">
		<!-- 🔙 Back to dashboard. Triggers a status refresh so the row badge
		     reflects whatever the user did on this screen. -->
		<button
			class="back-btn flex items-center gap-2 text-sm text-muted-foreground mb-6 bg-transparent border-none cursor-pointer p-0"
			@click=${() => {
				currentView = "dashboard";
				connectContainer = null;
				connectAuthUrl = null;
				connectError = null;
				renderApp();
				// 🔄 Refresh badges after the user comes back, so a freshly
				// connected/disconnected row updates immediately.
				void refreshGoogleStatuses();
			}}
		>
			${icon(ArrowLeft, "sm")}
			<span>Back to Dashboard</span>
		</button>

		<div class="glow-border rounded-lg bg-card p-8 max-w-3xl">
			<h2 class="text-xl font-bold tracking-tight mb-1">🎮 Connect Google for ${c.agentName}</h2>
			<p class="text-sm text-muted-foreground mb-2">
				${isHermesGoogle
					? html`Lets this Hermes agent (<span class="font-mono">${c.containerName}</span>) use Google Workspace, including Gmail, Calendar, Drive, Sheets, and Docs.`
					: html`Lets this agent (<span class="font-mono">${c.containerName}</span>) read your Google Calendar, Sheets, and Docs (read-only).`}
			</p>
			<p class="text-xs text-muted-foreground/70 mb-8">
				${isHermesGoogle
					? html`🧪 Hermes Google runs in our closed Google OAuth Testing pilot. If Google shows <span class="font-mono">access_denied</span>, ask PekTown support to add this Gmail as a test user.`
					: html`🔒 We request <strong>read-only</strong> scopes only. Tokens are stored encrypted inside this agent's container and never leave it.`}
			</p>

			<hr class="sci-fi-divider mb-6" />

			<!-- 1️⃣ STEP 1 — collect the email, mint an auth URL via gog --remote --step 1.
			     Inputs lock once we have a URL so the user can't accidentally re-mint
			     mid-paste (a fresh URL would invalidate the cached state). -->
			<div class="form-row">
				<label class="form-label sci-fi-label">1. Your Google email</label>
				<div class="form-field">
					${Input({
						type: "email",
						placeholder: "you@gmail.com",
						value: connectEmail,
						disabled: connectAuthUrl !== null || connectInFlight !== null,
						onInput: (e) => { connectEmail = (e.target as HTMLInputElement).value; },
					})}
					<p class="text-xs text-muted-foreground/70 mt-1.5">
						Used to pre-fill Google's account picker so you don't have to scroll
						through every signed-in profile.
					</p>
				</div>
			</div>

			<!-- 🎬 Get auth link — only shows while step 1 hasn't been run yet. -->
			${connectAuthUrl === null ? html`
				<div class="flex justify-end mt-4">
					${Button({
						className: "glow-btn",
						disabled: connectInFlight === "step1",
						onClick: () => void handleGetAuthLink(),
						children: connectInFlight === "step1"
							? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Generating link…</span>`
							: html`<span class="flex items-center gap-1.5">${icon(ExternalLink, "sm")} Get auth link</span>`,
					})}
				</div>
			` : html`
				<!-- 2️⃣ STEP 2 — once we have the URL, expose it as a clickable link
				     plus instructions for the paste-back dance. -->
				<hr class="sci-fi-divider mt-8 mb-6" />

				<div class="form-row">
					<label class="form-label sci-fi-label">2. Approve at Google</label>
					<div class="form-field">
						<a
							href=${connectAuthUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline break-all"
						>${icon(ExternalLink, "xs")} Open Google authorization page</a>
						<ol class="text-xs text-muted-foreground/80 mt-2 space-y-1 list-decimal list-inside">
							<li>Click the link above; Google asks you to confirm scopes.</li>
							<li>After approving, your browser will show a <em>"site can't be reached"</em> page — that's expected (the redirect points at a local-only port).</li>
							<li>Copy the <strong>full URL</strong> from your browser's address bar (it'll start with <span class="font-mono">http://127.0.0.1:…</span>) and paste it below.</li>
						</ol>
					</div>
				</div>

				<div class="form-row">
					<label class="form-label sci-fi-label">3. Paste the redirect URL</label>
					<div class="form-field">
						${Input({
							type: "text",
							placeholder: "http://127.0.0.1:53473/oauth2/callback?code=…",
							value: connectRedirectUrl,
							disabled: connectInFlight === "step2",
							onInput: (e) => { connectRedirectUrl = (e.target as HTMLInputElement).value; },
						})}
					</div>
				</div>

				<div class="flex justify-end gap-3 mt-4">
					${Button({
						variant: "outline",
						className: "glow-btn",
						disabled: connectInFlight !== null,
						children: "Start over",
						onClick: () => {
							// 🔁 Discard the auth URL + paste so the user can re-enter
							// a different email or just retry. Keeps email in case they
							// want to fix a typo.
							connectAuthUrl = null;
							connectRedirectUrl = "";
							connectError = null;
							renderApp();
						},
					})}
					${Button({
						className: "glow-btn",
						disabled: connectInFlight === "step2",
						children: connectInFlight === "step2"
							? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Connecting…</span>`
							: html`<span class="flex items-center gap-1.5">🔑 Connect</span>`,
						onClick: () => void handleConnect(),
					})}
				</div>
			`}

			<!-- ⚠️ Error banner — same look as the create/edit form's formError. -->
			${connectError ? html`
				<div class="mt-6 px-4 py-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-500">
					⚠️ ${connectError}
				</div>
			` : ""}

			<!-- 📇 Connected accounts — listed at the bottom so a returning user
			     immediately sees what's already wired up. Each row has its own
			     Disconnect button. -->
			<hr class="sci-fi-divider mt-10 mb-4" />
			<h3 class="text-sm font-semibold tracking-wide uppercase opacity-70 mb-3">Connected accounts</h3>
			${isFetchingStatus
				? html`<p class="text-sm text-muted-foreground/70">⏳ Checking…</p>`
				: accounts.length === 0
					? html`<p class="text-sm text-muted-foreground/70">No Google accounts connected yet.</p>`
					: html`<ul class="flex flex-col gap-2">
						${accounts.map((a) => html`
							<li class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-border/50 bg-muted/20">
								<div class="flex flex-col min-w-0">
									<span class="font-mono text-sm truncate">${a.email}</span>
									${a.services ? html`<span class="text-xs text-muted-foreground/70">${a.services}</span>` : ""}
								</div>
								${Button({
									variant: "outline",
									size: "sm",
									className: "glow-btn shrink-0",
									disabled: connectInFlight === a.email,
									onClick: () => void handleDisconnect(a.email),
									children: connectInFlight === a.email
										? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Disconnecting…</span>`
										: html`<span class="flex items-center gap-1.5">🚪 Disconnect</span>`,
								})}
							</li>
						`)}
					</ul>`}
		</div>
	</div>
	`;
};

// ============================================================================
// 📱 Connect WhatsApp View — full-page screen, mirrors renderConnectGoogleView.
// Two states under the hood:
//   • connected → "logged in" success block + Logout button.
//   • not connected → QR <img> rendered client-side from waState.qrText (auto-
//     refreshes via the 3 s status poll picking up new qrSeq from the helper),
//     plus instructions + Cancel/Try-again actions.
// ============================================================================

// 🖼️ Render a QR string to a data-URL <img> tag. cellSize=4 + margin=2 keeps
// the encoded image small (~150 px native); the wrapper around it scales
// fluidly via CSS for whatever viewport we're on. Error correction "M" matches
// WhatsApp's printed QR conventions — their reader tolerates moderate damage
// gracefully even when scaled.
const renderQrImg = (qrText: string): string => {
	const qr = qrcode(0, "M");
	qr.addData(qrText);
	qr.make();
	// 📦 createImgTag(cellSize, margin) returns `<img src="data:image/gif;…">`.
	// We unsafeHTML it into the responsive wrapper below.
	return qr.createImgTag(4, 2);
};

const renderConnectWhatsappView = () => {
	if (!connectWhatsappContainer) {
		// 🛟 Defensive — if we landed here without a target, snap back to the
		// dashboard instead of rendering a half-page.
		currentView = "dashboard";
		stopWaPolling();
		return renderDashboard();
	}
	const c = connectWhatsappContainer;

	// ────────────────────────────────────────────────────────────────────────
	// 🎚️ Derived UI flags — translate the raw status snapshot into named
	// branches the template can switch on. Order matters when multiple are
	// true (the template checks them top-to-bottom in the same order below).
	// ────────────────────────────────────────────────────────────────────────

	// ⏳ First paint, before any /status response has landed. Empty waState
	// AND no fetch error yet → we're still talking to the API.
	const isLoading = waState === null && !waError;

	// ⏸️ Container itself is stopped — /status short-circuits with this flag
	// instead of trying to spawn the helper. User has to start it from the
	// dashboard first.
	const stopped = waState?.stopped === true;

	// ✅ Auth done, gateway is ready. Server-side flow already restarted the
	// gateway and stripped restartNeeded from state.json before we got here.
	const isConnected = waState?.connected === true;

	// 👋 The user just clicked Logout and the unlink succeeded. We DON'T want
	// to fall through into the QR-generating spinner — that would feel like
	// the app silently re-spawned a new login behind the user's back. Highest
	// branch priority (after stopped/loading) so we always show the friendly
	// "Disconnected" card even if waState says {connected:false}.
	const justLoggedOut = waJustLoggedOut;

	// 📷 Helper produced a fresh pairing string. Baileys rotates these every
	// ~20s; each new qrSeq triggers a re-render below.
	const hasQr = !!waState?.qrText && !isConnected;

	// ⏰ Helper hit its 2-minute scan-window and wrote {error:"timeout"} —
	// or some other terminal failure surfaced (logged_out, handler_error,
	// unparseable output). Without this branch we'd stay stuck on the
	// "Generating QR code…" spinner forever (poll already self-stopped on
	// s.error, and the qrText is gone). "timeout" gets a soft amber tone
	// with friendly retry copy; everything else gets a red tone + raw text
	// so we don't lie about what happened.
	const helperError = !isConnected && !hasQr && !justLoggedOut && typeof waState?.error === "string"
		? waState.error
		: null;
	const isExpired = helperError === "timeout";

	// 🔢 Pretty phone number for the success copy. Falls back to a generic
	// label if the helper didn't manage to parse our self-jid.
	const phoneLabel = waState?.e164 ? `+${waState.e164}` : "your linked number";

	const back = () => {
		currentView = "dashboard";
		connectWhatsappContainer = null;
		waState = null;
		waError = null;
		stopWaPolling();
		renderApp();
		// 🔄 Refresh per-row badge so a freshly connected/disconnected row
		// updates immediately. Not a re-poll of every container — just this
		// one if we have its name. Falls back to the full sweep if the user
		// did something that might have changed multiple rows (rare).
		void refreshWhatsappStatuses();
	};

	return html`
	<div class="fade-in">
		<button
			class="back-btn flex items-center gap-2 text-sm text-muted-foreground mb-6 bg-transparent border-none cursor-pointer p-0"
			@click=${back}
		>
			${icon(ArrowLeft, "sm")}
			<span>Back to Dashboard</span>
		</button>

		<div class="glow-border rounded-lg bg-card p-4 sm:p-8 max-w-3xl">
			<h2 class="text-xl font-bold tracking-tight mb-1">📱 Connect WhatsApp for ${c.agentName}</h2>
			<p class="text-sm text-muted-foreground mb-2">
				Lets this agent (<span class="font-mono">${c.containerName}</span>) send and receive
				WhatsApp messages on your behalf.
			</p>
			<p class="text-xs text-muted-foreground/70 mb-8">
				🔒 Your account stays linked as a "Linked Device" — same as WhatsApp Web. You can
				unlink anytime from this page or from your phone's Linked Devices screen.
			</p>

			<hr class="sci-fi-divider mb-6" />

			${stopped ? html`
				<div class="px-4 py-3 rounded-md border border-amber-500/40 bg-amber-500/10 text-sm text-amber-500">
					⏸️ This agent is stopped. Start it from the dashboard, then click 📱 again.
				</div>
			` : isLoading ? html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					<span aria-hidden="true">⏳</span>
					<span>Checking WhatsApp status…</span>
				</div>
			` : isConnected ? html`
				<!-- ✅ Already-logged-in branch. -->
				<div class="flex flex-col gap-4">
					<div class="px-4 py-3 rounded-md border border-green-500/40 bg-green-500/10 text-sm text-green-500">
						✅ You are logged in to WhatsApp channel${waState?.e164 ? html` as <span class="font-mono">${phoneLabel}</span>` : ""}.
					</div>
					<p class="text-xs text-muted-foreground/70">
						Inbound WhatsApp messages will be routed to this agent. To unlink, click Logout
						below — that triggers a server-side device unlink (same as removing the linked
						device from your phone). The other channels (Telegram, etc.) are unaffected.
					</p>
					<div class="flex justify-end">
						${Button({
							variant: "outline",
							className: "glow-btn",
							disabled: waInFlight === "logout",
							onClick: () => void handleWaLogout(),
							children: waInFlight === "logout"
								? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Logging out…</span>`
								: html`<span class="flex items-center gap-1.5">🚪 Logout</span>`,
						})}
					</div>
				</div>
			` : hasQr ? html`
				<!-- 📷 QR + scan instructions. -->
				<div class="flex flex-col items-center gap-4">
					<!-- 🖼️ QR image — re-rendered every poll tick when qrSeq changes
					     (Baileys rotates the underlying string ~every 20s).
					     📐 Responsive sizing: ~160px on tiny phones, 192px on small
					     screens, 224px on tablets+. The inner <img> stretches to fill
					     via [&_img]:w-full and image-rendering:pixelated keeps the
					     QR cells crisp at any scale (no blurry interpolation that
					     could trip up the WhatsApp scanner). -->
					<div
						class="bg-white p-3 rounded-md w-[160px] sm:w-[192px] md:w-[224px] [&_img]:w-full [&_img]:h-auto [&_img]:block"
						style="image-rendering: pixelated;"
					>
						${unsafeHTML(renderQrImg(waState!.qrText!))}
					</div>
					<div class="text-xs text-muted-foreground/70 text-center max-w-md">
						<ol class="text-left space-y-1 list-decimal list-inside">
							<li>Open <strong>WhatsApp</strong> on your phone.</li>
							<li>Tap <strong>⋮ &nbsp;→ Linked Devices &nbsp;→ Link a Device</strong>.</li>
							<li>Point your phone at this QR code.</li>
						</ol>
						<p class="mt-3 opacity-70">QR auto-refreshes every ~20 seconds until you scan it.</p>
					</div>
					<div class="flex gap-3">
						${Button({
							variant: "outline",
							className: "glow-btn",
							onClick: back,
							children: html`<span class="flex items-center gap-1.5">Cancel</span>`,
						})}
					</div>
				</div>
			` : waError ? html`
				<!-- ⚠️ Error path — show Try Again. -->
				<div class="flex flex-col gap-4">
					<div class="px-4 py-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-500">
						⚠️ ${waError}
					</div>
					<div class="flex justify-end">
						${Button({
							className: "glow-btn",
							disabled: waInFlight === "login",
							onClick: () => void handleStartWaLogin(),
							children: waInFlight === "login"
								? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Retrying…</span>`
								: html`<span class="flex items-center gap-1.5">🔄 Try again</span>`,
						})}
					</div>
				</div>
			` : isExpired ? html`
				<!-- ⏰ The helper waited 2 minutes for a phone scan and gave up.
				     QR string is gone (Baileys closed its socket), so showing the
				     stale code would just frustrate the user. Two clear options:
				     generate a fresh QR right here, or bail back to the dashboard
				     and start over from the row's 📱 button. -->
				<div class="flex flex-col gap-4">
					<div class="px-4 py-3 rounded-md border border-amber-500/40 bg-amber-500/10 text-sm text-amber-500">
						⏰ The QR code expired before it was scanned (2-minute window).
						Please go back to the dashboard and click 📱 WhatsApp again to
						generate a fresh QR — or hit "Generate new QR" below to retry here.
					</div>
					<div class="flex justify-end gap-3">
						${Button({
							variant: "outline",
							className: "glow-btn",
							onClick: back,
							children: html`<span class="flex items-center gap-1.5">← Back to Dashboard</span>`,
						})}
						${Button({
							className: "glow-btn",
							disabled: waInFlight === "login",
							onClick: () => void handleStartWaLogin(),
							children: waInFlight === "login"
								? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Generating…</span>`
								: html`<span class="flex items-center gap-1.5">🔄 Generate new QR</span>`,
						})}
					</div>
				</div>
			` : helperError ? html`
				<!-- ⚠️ Non-timeout terminal helper error (logged_out / handler_error /
				     unparseable output). Same shape as the expired branch but with the
				     raw error string so we don't lie about what happened. -->
				<div class="flex flex-col gap-4">
					<div class="px-4 py-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-500">
						⚠️ WhatsApp login failed: ${helperError}. Please go back to the
						dashboard and retry connecting WhatsApp.
					</div>
					<div class="flex justify-end gap-3">
						${Button({
							variant: "outline",
							className: "glow-btn",
							onClick: back,
							children: html`<span class="flex items-center gap-1.5">← Back to Dashboard</span>`,
						})}
						${Button({
							className: "glow-btn",
							disabled: waInFlight === "login",
							onClick: () => void handleStartWaLogin(),
							children: waInFlight === "login"
								? html`<span class="flex items-center gap-1.5 opacity-70">⏳ Retrying…</span>`
								: html`<span class="flex items-center gap-1.5">🔄 Try again</span>`,
						})}
					</div>
				</div>
			` : html`
				<!-- ⏳ Pending — helper is spinning up; first poll tick should pick
				     up a QR within a couple of seconds. -->
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					<span aria-hidden="true">⏳</span>
					<span>Generating QR code…</span>
				</div>
			`}

			<!-- ⚠️ Inline error banner — shown alongside the active branch above
			     when a transient action error needs surfacing without disrupting
			     the QR (e.g. logout failed but we're still showing the QR). -->
			${(waError && (isConnected || hasQr)) ? html`
				<div class="mt-6 px-4 py-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-500">
					⚠️ ${waError}
				</div>
			` : ""}
		</div>
	</div>
	`;
};

// ============================================================================
// 🏠 Main App Shell — the outermost wrapper
// Branding up top, then either the dashboard or the create form.
// Scanlines for that retro-future CRT monitor feel. 🖥️✨
// ============================================================================
// 🔐 Full-screen sign-in view — shown when signedInUser is null. Nothing else
// renders behind it; the dashboard is gated entirely on a valid Google login.
const renderLoginView = () => html`
	<div class="w-full min-h-screen bg-background text-foreground scanlines flex items-center justify-center">
		<!-- 📦 Centered sign-in box — width matches the GIS button (260px, see
		     renderGoogleButton). rounded-[5px] + border gives it a subtle frame.
		     📐 No flex gap on the column because we want UNEVEN spacing: only
		     5px between the bird and "Pektown", then larger breathing room
		     before the sign-in button. Per-child margins encode that. -->
		<div class="w-[260px] rounded-[5px] border border-border py-8 flex flex-col items-center fade-in">
			<!-- 🐦 Brand mark on the sign-in page so it doesn't look empty.
			     📏 No fixed height on the wrapper — we want it to hug the SVG
			     so "Pektown" sits right below the bird's legs. Inline style on
			     the inner SVG overrides the shared 80×80 rule from app.css and
			     keeps the natural 100:56 aspect ratio (so no top/bottom slack). -->
			<div class="brand-icon [&_svg]:!w-[96px] [&_svg]:!h-auto [&_svg]:block">${woodpeckerSvg}</div>
			<!-- 🏷️ Title hugs the bird — override the shared 48px line-height
			     (which bakes ~8px of half-leading above the cap-height and
			     pushes the text visually away from the bird's feet) down to 1,
			     then add just a hair of breathing room. -->
			<h1 class="brand-name brand-gradient !leading-none mt-[2px]">Pektown</h1>
			<!-- 🪄 GIS drops its rendered button inside this div.
			     mt-6 (24px) visually separates the "logo" group from the action. -->
			<div id="google-btn" class="mt-6"></div>
		</div>
	</div>
`;

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	// 🚪 Not logged in? Render only the sign-in page, then hand the
	// #google-btn div to GIS to paint its button into.
	if (!signedInUser) {
		render(renderLoginView(), app);
		renderGoogleButton();
		return;
	}

	const appHtml = html`
		<div class="w-full min-h-screen bg-background text-foreground scanlines">
			<div class="max-w-5xl mx-auto px-4 py-4">
				<!-- 🐧 Branding — Side-view Penguin + Pektown + Theme Toggle -->
				${renderBranding()}

				<!-- ✂️ Gradient divider — separates branding from content -->
				<hr class="sci-fi-divider mb-4" />

				<!-- 📍 Current view — dashboard, create/edit form, or Connect Google.
				     Only one ever renders; the others fully unmount so their state
				     resets cleanly on next open. -->
				${currentView === "dashboard"
					? renderDashboard()
					: currentView === "connect-google"
						? renderConnectGoogleView()
						: currentView === "connect-whatsapp"
							? renderConnectWhatsappView()
							: currentView === "import-backup"
								? renderImportBackupView()
								: currentView === "delete-agent"
									? renderDeleteAgentView()
									: renderCreateView()}
			</div>

			<!-- 🔔 Error toast — fixed bottom-right, visible across views. Only
			     renders when toastMessage is non-null; auto-dismisses after 5 s
			     (see showErrorToast). Click to dismiss early. Low-fi styling —
			     one message at a time, no queue, no animation framework. -->
			${toastMessage ? html`
				<div
					role="alert"
					class="fixed bottom-4 right-4 max-w-sm px-4 py-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-500 shadow-lg cursor-pointer"
					@click=${dismissToast}
				>
					⚠️ ${toastMessage}
				</div>
			` : ""}
		</div>
	`;

	render(appHtml, app);
};

// ============================================================================
// ⏱️ Auto-poll machinery — the dashboard is otherwise event-driven (refresh
// on click), but a container in "starting" needs repeated looks to catch
// the flip to "running". Rather than polling the API all day long, we only
// turn the timer on while something is actually starting, then shut it off.
//
// Guardrails:
//   • one timer at a time (handle tracked below, cleared before re-schedule)
//   • hard 90 s deadline per "starting" window — a genuinely stuck gateway
//     shouldn't hammer pektown-api forever; the user's Refresh button is
//     always available if they want to keep trying
//   • skip ticks while the tab is hidden — background polling is wasteful;
//     we resume on visibilitychange (which also fires an immediate refetch)
// ============================================================================
let pollHandle: number | null = null;
let pollDeadline = 0; // ms epoch — stop polling after this instant

const anyStarting = (): boolean =>
	containers.some((c) => c.status === "starting");

const stopStartingPoll = () => {
	if (pollHandle !== null) {
		clearInterval(pollHandle);
		pollHandle = null;
	}
};

const ensureStartingPoll = () => {
	if (!anyStarting()) { stopStartingPoll(); return; }
	// 🔁 Extend the deadline each time a fresh "starting" shows up (e.g.
	// user starts a second container 20 s into the first one's boot).
	pollDeadline = Date.now() + 90_000;
	if (pollHandle !== null) return; // already ticking
	// ⏱️ 3 s cadence — fast enough to feel live, slow enough not to spam.
	pollHandle = window.setInterval(() => {
		if (Date.now() >= pollDeadline) {
			// 😴 Caller gave up; user can still hit Refresh manually.
			stopStartingPoll();
			return;
		}
		if (document.visibilityState !== "visible") return; // 🫥 tab hidden
		void loadContainers();
	}, 3000);
};

// 👀 When the user flips back to this tab, do an immediate refetch so they
// don't stare at a stale "starting" for up to 3 seconds before the next tick.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible" && anyStarting()) {
		void loadContainers();
	}
});

// ============================================================================
// 🛰️ Data loader — fetches containers from pektown-api, updates state, re-renders.
// Called on boot, after every Start/Stop, whenever the user hits Refresh,
// and on each tick of the auto-poll above while any container is starting.
// ============================================================================
const loadContainers = async (): Promise<void> => {
	isLoading = true;
	loadError = null;
	renderApp();
	try {
		containers = await fetchContainers();
	} catch (err) {
		loadError = (err as Error).message;
	} finally {
		isLoading = false;
		renderApp();
		// 🎬 (Re)evaluate the auto-poll after every fetch. If the list now
		// has a "starting" row, make sure the timer is running; if not,
		// shut it down. This one call keeps the machinery coherent across
		// boot, manual refresh, post-action refetch, and each poll tick.
		ensureStartingPoll();
		// 🎮 Kick off Google-status fetches in the background so the row
		// badges paint shortly after the table itself. Fire-and-forget;
		// it re-renders on each per-row resolution. Don't await — the
		// dashboard shouldn't block on a side feature.
		void refreshGoogleStatuses();
		// 📱 One-shot WhatsApp status sweep — only on the first successful
		// loadContainers, NOT on every poll tick. Status changes rarely;
		// per-tick fan-out would be wasted docker-exec calls. Subsequent
		// updates flow through the connect-screen back-nav handler.
		if (!waInitialRefreshDone && containers.length > 0) {
			waInitialRefreshDone = true;
			void refreshWhatsappStatuses();
		}
	}
};

// 🧠 One-shot fetch of the provider/model menu. Cheap (single small query)
// and cached in module scope for the rest of the session. We don't retry on
// failure — if the user opens the create form before this resolves they'll
// see an empty dropdown, which is obvious, and a reload fixes it. A second
// call is a no-op replacement of the cache.
const loadAiModels = async (): Promise<void> => {
	try {
		aiModels = await fetchAiModels();
		// 🎨 Important: this fetch races independently of loadContainers(). If it
		// resolves after the dashboard rendered, we must repaint so provider/model
		// dropdowns and saved-key hints see the fresh catalog.
		renderApp();
	} catch (err) {
		// 🛟 Don't crash the dashboard over this — the containers list still
		// works. Surface it in the error banner so the user sees *something*.
		loadError = `ai-models: ${(err as Error).message}`;
		renderApp();
	}
};

// 🚀 Ignition sequence complete. All systems nominal. Launch! 🛸
loadSavedUser();       // 🔁 restore prior Google session if any
renderApp();
if (signedInUser) {
	void loadContainers(); // 📡 only fetch if logged in
	void loadAiModels();   // 🧠 provider/model catalog for the create/edit form
}
