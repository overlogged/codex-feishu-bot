# Codex Bootstrap Playbook

This playbook is written for a fresh Codex session operating this repository on behalf of the user.

## Operator Objective

End state:

- Feishu developer app configured
- `.env.real` filled
- external Codex app-server up
- bot process up
- Health and smoke checks passing

## Required Commands

Run from repository root:

```bash
pnpm install
pnpm bootstrap:env
pnpm chrome:debug
```

If `agent-browser` is missing and browser automation is available through shell commands, install it:

```bash
npm install -g agent-browser
agent-browser install
```

## Browser Automation Path

1. Ask the user one explicit question first: whether they want to create a new bot.
2. If the answer is yes, run `npx -y lark-op-cli@latest create-bot --name "Codex 机器人"`.
3. In the create-bot branch, read the command output continuously instead of waiting for process exit.
4. In the create-bot branch, if the command shows an ASCII QR code or other login prompt, surface it to the user immediately so they can scan or confirm.
5. If the answer is no, connect to the Chrome CDP endpoint started by `pnpm chrome:debug`.
6. Open the Feishu Open Platform app list.
7. If the user is not logged in, stop and ask them to finish login in that browser window.
8. In the browser branch, continue with the original browser/CDP path and select an existing target bot in Feishu Open Platform. Do not create a new bot in this branch.
9. After the target bot/app is confirmed, continue without asking the user to click through normal console steps.
10. Follow the target state in `docs/feishu-console-automation.md`.
11. Persist the resulting `FEISHU_APP_ID` and `FEISHU_APP_SECRET` into `.env.real`.
12. If the user's machine already has `~/.codex/auth.json`, set `CODEX_HOME_SOURCE` in `.env.real` to that absolute host path. Only use `OPENAI_API_KEY` when local Codex auth is missing.
13. Keep `DEFAULT_WORKSPACE` pointed at `/home/overlogged` unless the user explicitly wants another host root.
14. Keep `CODEX_ARTIFACTS_DIR` pointed at the default artifact directory unless the user explicitly wants another export location.
15. Group chats must not run until they are bound to a subdirectory under `DEFAULT_WORKSPACE`.
16. The group binding flow is: private-chat the bot with `工作区`, then bind inside the target group with `@bot <编号>` or equivalent natural language. All sessions run directly on the host. Codex bindings default to `gpt-6-astra` with `high` reasoning; they can select `gpt-5.6-sol` and `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` reasoning explicitly.

## Runtime Setup

After Feishu console setup:

```bash
pnpm codex:host
pnpm build:host
pnpm start
pnpm host:smoke
```

If smoke passes, provide the user with:

- the app name used
- whether an existing app was reused or a new one was created
- the external Codex status
- the app process status
- how to test the bot in Feishu

## Guardrails

- Do not ask the user to manually configure ordinary Feishu console steps.
- Do not move `codex app-server` into a container; it must run on the host.
- Do not expose secrets in terminal output beyond what is necessary to write `.env.real`.
- If tenant policy blocks a permission or release action, explain exactly which screen is blocked and resume after the user resolves it.
