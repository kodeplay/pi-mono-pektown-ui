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
import { Plus, Play, Square, ArrowLeft } from "lucide";
import { icon } from "@mariozechner/mini-lit";
import "./app.css";

// ============================================================================
// 📦 Types — one interface to rule them all
// ============================================================================
interface Container {
	agentName: string;
	status: "running" | "stopped";
	currentRunHours: number;  // ⏱️ hours in the current run (0 if stopped)
	totalHours: number;       // 📈 cumulative hours across all runs
}

// ============================================================================
// 🎭 Mock Data — our brave pretend containers, standing in until the backend arrives
// "They may be fake, but their service is real." 🫡
// ============================================================================
const MOCK_CONTAINERS: Container[] = [
	{ agentName: "priyatron", status: "running", currentRunHours: 1.23, totalHours: 14.56 },
	{ agentName: "karan-tron-bot", status: "stopped", currentRunHours: 0, totalHours: 6.96 },
	{ agentName: "logs-test", status: "running", currentRunHours: 0.0, totalHours: 0.0 },
	{ agentName: "karan-three-test", status: "stopped", currentRunHours: 0, totalHours: 2.1 },
];

// 🧠 Static model list — the brains you can plug in
const AI_MODELS = [
	{ value: "gpt-4o", label: "GPT-4o" },
	{ value: "gpt-4o-mini", label: "GPT-4o-mini" },
	{ value: "claude-sonnet", label: "Claude Sonnet" },
	{ value: "claude-haiku", label: "Claude Haiku" },
];

// ============================================================================
// 🗄️ State — one string and an array. That's the whole app state.
// Simplicity is the ultimate sophistication. — Leonardo da Vinci (probably)
// ============================================================================
let containers = MOCK_CONTAINERS;
let currentView: "dashboard" | "create" = "dashboard"; // 📍 which "page" we're on

// 🔢 Format hours nicely: 1.23 → "1.23h"
const formatHours = (hours: number): string => hours.toFixed(2) + "h";

// ============================================================================
// 🐦 Woodpecker SVG — custom side-view woodpecker with a prominent beak
// The beak is rendered in a warm contrasting orange/amber color 🔶
// No Lucide icon for this one — hand-crafted with love. 🪶
// ============================================================================
const woodpeckerSvg = html`
<svg class="brand-icon-svg" viewBox="0 0 76 56" fill="none" xmlns="http://www.w3.org/2000/svg">
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

		<!-- 🌙☀️ Dark/Light mode toggle — right next to the branding -->
		<div class="flex items-center">
			<theme-toggle></theme-toggle>
		</div>
	</div>
`;

// ============================================================================
// 📋 Table Row — one row per agent container
// 🟢 running = pulsing green dot + Stop button
// ⚪ stopped = gray dot + Start button
// Row height matches form field height for visual consistency 📏
// ============================================================================
const renderRow = (c: Container) => {
	const isRunning = c.status === "running";
	return html`
		<tr class="border-b border-border/50 transition-colors">
			<!-- 🏷️ Agent name — the human-friendly identifier -->
			<td class="px-4 font-medium font-mono text-sm">${c.agentName}</td>

			<!-- 🚦 Status badge with animated dot for running containers -->
			<td class="px-4">
				${Badge({
					variant: isRunning ? "default" : "secondary",
					children: html`<span class="flex items-center gap-1.5">
						<span class="w-2 h-2 rounded-full ${isRunning ? "bg-green-400 pulse-dot" : "bg-gray-500"}"></span>
						${c.status}
					</span>`,
				})}
			</td>

			<!-- ⏱️ Current run hours (dash if stopped — container is in cryo-sleep 🧊) -->
			<td class="px-4 tabular-nums font-mono text-sm col-hours">${isRunning ? formatHours(c.currentRunHours) : "—"}</td>

			<!-- 📈 Total hours across all runs -->
			<td class="px-4 tabular-nums font-mono text-sm col-hours">${formatHours(c.totalHours)}</td>

			<!-- 🎮 Action button — static for now, will fire API calls in Phase 2 -->
			<td class="px-4">
				${isRunning
					? Button({
							variant: "outline",
							size: "sm",
							className: "glow-btn",
							children: html`<span class="flex items-center gap-1.5">${icon(Square, "xs")} Stop</span>`,
						})
					: Button({
							variant: "outline",
							size: "sm",
							className: "glow-btn",
							children: html`<span class="flex items-center gap-1.5">${icon(Play, "xs")} Start</span>`,
						})}
			</td>
		</tr>
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
// 📊 Agents Table — the main event! Five columns of container data 🏆
// Wrapped in a glowing card because flat borders are so 2023.
// ============================================================================
const renderTable = () => html`
	<table class="w-full text-sm sci-fi-table">
		<thead>
			<tr class="border-b border-border/50 text-left">
				<th class="px-4 py-3 sci-fi-label">Agent</th>
				<th class="px-4 py-3 sci-fi-label">Status</th>
				<th class="px-4 py-3 sci-fi-label col-hours">Current Run</th>
				<th class="px-4 py-3 sci-fi-label col-hours">Total Hours</th>
				<th class="px-4 py-3 sci-fi-label">Actions</th>
			</tr>
		</thead>
		<tbody>
			${containers.map(renderRow)}
		</tbody>
	</table>
`;

// ============================================================================
// 📊 Dashboard View — the main page with branding + table
// This is home base. Command central. The bridge of the starship. 🚀
// ============================================================================
const renderDashboard = () => html`
	<div class="fade-in">
		<!-- 🏠 Section header — title + create button -->
		<div class="flex items-center justify-end mb-4">
			${Button({
				className: "glow-btn",
				children: html`<span class="flex items-center gap-1.5">${icon(Plus, "sm")} Create Agent</span>`,
				onClick: () => {
					currentView = "create";
					renderApp();
				},
			})}
		</div>

		<!-- 📊 Table card — glowing, hoverable, futuristic ✨ -->
		<div class="glow-border rounded-lg overflow-hidden bg-card">
			${containers.length > 0 ? renderTable() : renderEmptyState()}
		</div>

		<!-- 📡 Footer status bar — because sci-fi dashboards always have one -->
		<div class="mt-4 flex items-center justify-between text-xs text-muted-foreground/60">
			<span>${containers.length} container${containers.length !== 1 ? "s" : ""} registered</span>
			<span>${containers.filter(c => c.status === "running").length} active</span>
		</div>
	</div>
`;

// ============================================================================
// 📝 Create Agent View — full page form (no overlay dialogs here!)
// Replaces the dashboard view entirely. Back button takes you home.
// Labels are INLINE with fields — clean, compact, professional. 📐
// "To create is to give form to the void." — Some sci-fi book, probably
// ============================================================================
const renderCreateView = () => html`
	<div class="fade-in">
		<!-- 🔙 Back button — hover slides it left, nice touch 👌 -->
		<button
			class="back-btn flex items-center gap-2 text-sm text-muted-foreground mb-6 bg-transparent border-none cursor-pointer p-0"
			@click=${() => {
				currentView = "dashboard";
				renderApp();
			}}
		>
			${icon(ArrowLeft, "sm")}
			<span>Back to Dashboard</span>
		</button>

		<!-- 📝 Form card — same glow treatment as the table -->
		<div class="glow-border rounded-lg bg-card p-8 max-w-3xl">
			<h2 class="text-xl font-bold tracking-tight mb-1">Create Agent Container</h2>
			<p class="text-sm text-muted-foreground mb-8">Deploy a new agent to the fleet</p>

			<hr class="sci-fi-divider mb-8" />

			<!-- 📝 Form fields — inline layout: label left, field right -->
			<div>
				<!-- 🏷️ Agent name — choose wisely, this is how you'll know your creation -->
				<div class="form-row">
					<label class="form-label sci-fi-label">Agent name</label>
					<div class="form-field">
						${Input({ type: "text", placeholder: "my-agent" })}
					</div>
				</div>

				<!-- 🤖 Telegram bot token — optional gateway to Telegram land -->
				<div class="form-row">
					<label class="form-label sci-fi-label">Telegram bot token <span class="opacity-50">(opt)</span></label>
					<div class="form-field">
						${Input({ type: "password", placeholder: "Bot token from @BotFather" })}
					</div>
				</div>

				<!-- 👥 Telegram user IDs — the bouncer list. No token? No field needed. 🛡️ -->
				<div class="form-row">
					<label class="form-label sci-fi-label">Telegram user IDs</label>
					<div class="form-field">
						${Input({ type: "text", placeholder: "Comma-separated user IDs (required if bot token set)" })}
					</div>
				</div>

				<!-- ✂️ Visual break between comms config and AI config -->
				<hr class="sci-fi-divider mt-8 mb-2" />

				<!-- 🔑 AI API key — the secret sauce that powers the brain -->
				<div class="form-row">
					<label class="form-label sci-fi-label">AI API key</label>
					<div class="form-field">
						${Input({ type: "password", placeholder: "sk-... or anthropic key" })}
					</div>
				</div>

				<!-- 🧠 AI model — the brain transplant selector -->
				<div class="form-row">
					<label class="form-label sci-fi-label">AI model</label>
					<div class="form-field">
						${Select({
							value: "gpt-4o",
							options: AI_MODELS,
						})}
					</div>
				</div>

				<!-- 🎬 Action buttons — right-aligned, generous top spacing -->
				<div class="flex justify-end gap-3 mt-10">
					${Button({
						variant: "outline",
						className: "glow-btn",
						children: "Cancel",
						onClick: () => {
							currentView = "dashboard";
							renderApp();
						},
					})}
					${Button({
						className: "glow-btn",
						children: html`<span class="flex items-center gap-1.5">${icon(Plus, "sm")} Deploy Agent</span>`,
						// 🚧 TODO: wire up POST /api/agents when backend exists
					})}
				</div>
			</div>
		</div>
	</div>
`;

// ============================================================================
// 🏠 Main App Shell — the outermost wrapper
// Branding up top, then either the dashboard or the create form.
// Scanlines for that retro-future CRT monitor feel. 🖥️✨
// ============================================================================
const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full min-h-screen bg-background text-foreground scanlines">
			<div class="max-w-5xl mx-auto px-4 py-4">
				<!-- 🐧 Branding — Side-view Penguin + Pektown + Theme Toggle -->
				${renderBranding()}

				<!-- ✂️ Gradient divider — separates branding from content -->
				<hr class="sci-fi-divider mb-4" />

				<!-- 📍 Current view — dashboard or create form, never both -->
				${currentView === "dashboard" ? renderDashboard() : renderCreateView()}
			</div>
		</div>
	`;

	render(appHtml, app);
};

// 🚀 Ignition sequence complete. All systems nominal. Launch! 🛸
renderApp();
