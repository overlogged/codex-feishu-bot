# AGENTS.md

This repository is designed for a Codex-operated bootstrap flow.

## Primary Goal

Set up and deploy a Feishu bot backed by `codex app-server` with as little manual work as possible. The intended operator is another Codex session running on the user's machine.

## Required Execution Order

1. Read `README.md`.
2. Read `docs/codex-bootstrap-playbook.md`.
3. Read `docs/feishu-console-automation.md`.
4. Run `pnpm install`.
5. Run `pnpm bootstrap:env`.
6. Run `pnpm chrome:debug`.
7. Use browser automation through Chrome CDP to configure Feishu Open Platform.
8. Persist discovered values into `.env.real`.
9. Start external Codex with `pnpm codex:host`.
10. Build the app with `pnpm build:host`.
11. Start the bot process with `pnpm start`.
12. Verify with `pnpm host:smoke`.

## Browser Automation Rules

- Prefer Chrome DevTools Protocol automation over telling the user to click around manually.
- If `agent-browser` is available, prefer it. Otherwise use any browser/CDP capability available in Codex.
- Reuse an existing Feishu app when it is clearly the intended app; otherwise create a new enterprise self-built app.
- Drive the UI by visible labels and user goals, not brittle CSS selectors.

## What Still Requires the User

- Logging into Feishu Open Platform in the browser.
- Logging into OpenAI/Codex if the local `~/.codex` state is missing.
- Approving tenant-admin prompts if the organization requires them.

Only stop for those checkpoints. Do not push routine console clicking back onto the user.

## Deployment Rules

- Do not start `codex app-server` inside Docker. Start it on the host first with `pnpm codex:host`.
- The bot process should connect to the external `codex app-server` over `CODEX_APP_SERVER_LISTEN_URL`.
- Keep runtime secrets in `.env.real`.
- Keep Codex runtime work under `DEFAULT_WORKSPACE`, which defaults to `/home/overlogged`. Do not treat the repository checkout as the runtime workspace.
- Group chats must bind a subdirectory under `DEFAULT_WORKSPACE` before they can start tasks.
- The group binding flow is: private-chat the bot with `工作区` to get numbered subdirectories, then `@bot <编号>` inside the group to bind it.
- Default sessions should run in yolo mode: `CODEX_APP_SERVER_APPROVAL_POLICY=never` and `CODEX_APP_SERVER_SANDBOX=danger-full-access`.
- Keep generated user-facing files under `CODEX_ARTIFACTS_DIR` unless the user explicitly asks to write into the repository itself.
- Never commit `.env.real` or local browser profile data.
- Prefer `pnpm host:smoke` plus direct process logs for validation and debugging.

## Success Criteria

- Feishu app is configured for long connection mode.
- `im.message.receive_v1` is subscribed.
- Required IM permissions are granted.
- App credentials are present in `.env.real`.
- `pnpm codex:host` succeeds.
- `pnpm start` succeeds.
- `pnpm host:smoke` succeeds.
- Group chats can only run after they are bound to a workspace subdirectory.
- The user can message the bot in Feishu without additional manual setup.
