# Open Source Scope

## Supported v1 Flow

- A user opens this repository in Codex.
- Codex reads the repository instructions and bootstrap docs.
- Codex prepares `.env.real`, launches Chrome with CDP, and uses browser automation to configure Feishu Open Platform.
- Codex keeps generated deliverables in a separate artifacts directory instead of polluting the repository root.
- Codex runs against a dedicated mounted runtime workspace instead of the repository checkout root.
- The supported production path is a host-managed `codex app-server` plus a host-managed bot process.
- Codex starts both host processes and validates them.

## What Is Automated

- Local environment file scaffolding.
- Launching a dedicated Chrome debugging instance.
- Navigating Feishu Open Platform.
- Creating or reusing a Feishu app.
- Enabling bot capability, event subscription, permissions, and release flow.
- Writing discovered app credentials back into `.env.real`.
- Starting host services and running smoke checks.

## What Still Needs Human Presence

- Feishu login, SSO, 2FA, or tenant-admin approval.
- OpenAI/Codex authentication if local Codex state is missing.
- Final choice when the tenant already has multiple plausible Feishu apps and the target is ambiguous.

## Non-Goals for v1

- Automating Feishu developer-console setup via unsupported management APIs.
- Supporting Docker as the primary production path.
- Hiding every single third-party prompt; login and approval prompts still belong to the user.
