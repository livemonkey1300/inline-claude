# Inline Claude

Copilot-style AI inside VS Code, powered by **your own Claude Pro/Max subscription** through the Claude Code CLI. No Anthropic API key.

## Requirements
1. The `claude` CLI, **or** the official *Claude Code* VS Code extension (its bundled binary is auto-detected).
2. Signed in once with your Claude account: run `claude auth login` (or the command **Claude: Sign In**).

## Features
| Feature | How |
|---|---|
| **Inline edit** | `Ctrl+I` / `Cmd+I` — select code (or place the cursor), describe the change. Edit appears in place with **Accept (Ctrl+Enter) / Reject (Esc) / Diff** CodeLens. |
| **Ghost-text suggestions** | Type and pause; `Tab` to accept. `Alt+\` to trigger manually. |
| **Chat** | `Ctrl+Alt+I` — sidebar chat with streaming, `@file` mentions, Copy/Insert on code blocks. |
| **Hand off to Claude Code** | `Ctrl+Alt+Enter`, right-click → Claude → *Hand Off*, the lightbulb, or type `/agent …` in the `Ctrl+I` box — opens a new [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) session prefilled with your task, an `@file#L10-40` reference, the selected code and any errors. Press Enter there to let it do the multi-file heavy lifting. |
| **Ask / Agent modes** | *Ask* = no tools, cheapest. *Agent* = reads, searches and edits **multiple files** in your workspace. |
| **Right-click → Claude** | Inline Edit, Fix, Optimize, Add Docs, Explain, Write Tests, Ask about selection. Also a *Fix with Claude* quick fix on errors. |
| **AI commit message** | ✨ button in Source Control (staged diff, falls back to unstaged; matches your recent commit style). |
| **Model switch** | Status bar (`Ctrl+Alt+M`): Haiku / Sonnet / Opus / any id, separately for suggestions vs. chat/edit. |
| **Token control** | Status-bar usage, **Claude: Show Token Usage**, manual-suggestion mode, context caps, `leanMode`. |

## Staying light on tokens
- **`leanMode` (default on)** skips your user plugins/hooks/MCP servers/skills on every call. We measured **~200,000 tokens of overhead per request without it vs ~700 with it.** Project `CLAUDE.md` is still read.
- Suggestions use **Haiku**, send only ~60 lines before / 20 after the cursor, are debounced, cached and cancelled when you keep typing. Set `completions.mode` to `manual` for zero background usage.
- Ask mode attaches only the selection / a capped window of the active file and uses **no tools**.
- `subscriptionOnly` (default on) strips `ANTHROPIC_API_KEY` so you can never be billed per-token by accident.

## Safety
Agent mode edits files directly (`acceptEdits`) but **cannot run shell commands** unless you enable `inlineClaude.chat.allowBash`. Use git so you can review/revert.

## Notes
- Each request spawns the CLI, so a suggestion takes roughly 1–4 s. That's the cost of using the subscription login rather than the API.
- Usage counts against your Claude plan's 5-hour/weekly limits.

## Install
- **Marketplace:** search "Inline Claude" in the Extensions view (auto-updates through VS Code).
- **From GitHub (Windows / macOS / Linux):** download the `.vsix` from [Releases](https://github.com/livemonkey1300/inline-claude/releases), then `code --install-extension inline-claude-X.Y.Z.vsix` (or Extensions view → `…` → *Install from VSIX*). Sideloaded installs check GitHub Releases for new versions (`inlineClaude.autoUpdate`: `check` / `install` / `off`).

## Releasing (automatic)
Just push to `main` with [Conventional Commits](https://www.conventionalcommits.org). The Release workflow does the rest:

| Commit | Result |
|---|---|
| `fix:` / `perf:` / `refactor:` | patch `0.1.0 → 0.1.1` |
| `feat:` | minor `0.1.0 → 0.2.0` |
| `feat!:` or `BREAKING CHANGE:` | major (stays `0.x` until you move to 1.0 manually) |
| `docs:` `ci:` `test:` `chore:` only | no release |

It tests, bumps `package.json`, tags, builds the `.vsix`, creates the GitHub Release page with generated notes, and publishes to the stores. You can also force one from **Actions → Release → Run workflow**.

One-time setup: create a publisher at https://marketplace.visualstudio.com/manage and a Personal Access Token (Azure DevOps, scope *Marketplace → Manage*) → repo secret `VSCE_PAT`. For VSCodium/Cursor/Windsurf: token from https://open-vsx.org → secret `OVSX_PAT`.
