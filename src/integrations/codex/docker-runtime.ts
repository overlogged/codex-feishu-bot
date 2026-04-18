import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

import type { Env } from "../../config/env.js";

export interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DockerGroupInfo {
  gid: number;
  members: Set<string>;
}

interface DockerCommandInvocation {
  command: string;
  args: string[];
}

function formatCpuLimit(): string {
  const halfCpus = Math.max(1, availableParallelism() / 2);
  const rounded = Math.round(halfCpus * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function shellEscapeArg(part: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(parts: string[]): string {
  return parts.map((part) => shellEscapeArg(part)).join(" ");
}

function shellCommandPreview(args: string[]): string {
  return buildShellCommand(["docker", ...args]);
}

function normalizeDockerCommandError(args: string[], result: CommandResult): string {
  const raw = result.stderr.trim() || result.stdout.trim() || "docker 命令执行失败";
  const command = shellCommandPreview(args);

  if (
    raw.includes("permission denied while trying to connect to the Docker daemon socket") ||
    raw.includes("dial unix /var/run/docker.sock: connect: permission denied")
  ) {
    return [
      "Docker 模式当前不可用：bot 进程没有访问 Docker daemon 的权限。",
      "当前无法连接 `/var/run/docker.sock`。",
      "请把运行 bot 的用户加入 `docker` 组，或修复 Docker socket 权限后重试。",
      `失败命令：${command}`
    ].join("\n");
  }

  if (
    raw.includes("Cannot connect to the Docker daemon") ||
    raw.includes("Is the docker daemon running?")
  ) {
    return [
      "Docker 模式当前不可用：Docker daemon 没有启动。",
      "请先启动 Docker / OrbStack 后重试。",
      `失败命令：${command}`
    ].join("\n");
  }

  if (
    raw.includes("docker: command not found") ||
    raw.includes("spawn docker ENOENT") ||
    raw.includes("spawn sg ENOENT")
  ) {
    return [
      "Docker 模式当前不可用：宿主机上找不到 `docker` 命令。",
      "请先安装 Docker CLI 后重试。",
      `失败命令：${command}`
    ].join("\n");
  }

  if (raw.includes("executable file not found in $PATH")) {
    return [
      "Docker 模式当前不可用：运行镜像里找不到要执行的 CLI 命令。",
      "请确认它已安装在容器可见的路径里，例如映射到 `/home/.../.local/bin`，或直接烘焙进运行镜像。",
      `失败命令：${command}`
    ].join("\n");
  }

  return raw;
}

let dockerGroupInfoCache: DockerGroupInfo | null | undefined;

function lookupDockerGroupInfo(): DockerGroupInfo | null {
  if (dockerGroupInfoCache !== undefined) {
    return dockerGroupInfoCache;
  }

  const result = spawnSync("getent", ["group", "docker"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    dockerGroupInfoCache = null;
    return dockerGroupInfoCache;
  }

  const raw = result.stdout.trim();
  const [groupName, , gidRaw, membersRaw = ""] = raw.split(":");
  const gid = Number.parseInt(gidRaw ?? "", 10);
  if (groupName !== "docker" || !Number.isFinite(gid)) {
    dockerGroupInfoCache = null;
    return dockerGroupInfoCache;
  }

  dockerGroupInfoCache = {
    gid,
    members: new Set(
      membersRaw
        .split(",")
        .map((member) => member.trim())
        .filter(Boolean)
    )
  };
  return dockerGroupInfoCache;
}

function shouldRunDockerViaSg(): boolean {
  if (typeof process.getgroups !== "function") {
    return false;
  }

  const info = lookupDockerGroupInfo();
  const username = process.env.USER ?? process.env.LOGNAME;
  if (!info || !username) {
    return false;
  }

  if (process.getgroups().includes(info.gid)) {
    return false;
  }

  return info.members.has(username);
}

export function resolveDockerCommandInvocation(args: string[]): DockerCommandInvocation {
  if (!shouldRunDockerViaSg()) {
    return {
      command: "docker",
      args
    };
  }

  return {
    command: "sg",
    args: ["docker", "-c", buildShellCommand(["docker", ...args])]
  };
}

function pushDockerEnv(args: string[], key: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  args.push("-e", `${key}=${value}`);
}

function appendProcessEnvKeys(args: string[], keys: readonly string[]): void {
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      pushDockerEnv(args, key, value);
    }
  }
}

function appendProcessEnvPrefixes(args: string[], prefixes: readonly string[]): void {
  if (prefixes.length === 0) {
    return;
  }

  const seen = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || seen.has(key) || !prefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }

    seen.add(key);
    pushDockerEnv(args, key, value);
  }
}

function resolveDockerHome(): string {
  return process.env.HOME ?? "/home/overlogged";
}

function resolveDockerPath(home: string): string {
  const currentPath =
    process.env.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const localBin = `${home}/.local/bin`;
  return currentPath === localBin || currentPath.startsWith(`${localBin}:`)
    ? currentPath
    : `${localBin}:${currentPath}`;
}

export function buildDockerExecutionRunArgs(
  env: Env,
  options: {
    containerName?: string;
    detach?: boolean;
    interactive?: boolean;
    remove?: boolean;
    workdir?: string;
    publishPorts?: string[];
    extraEnv?: Record<string, string | undefined>;
    passthroughEnvPrefixes?: readonly string[];
    command: string[];
  }
): string[] {
  const home = resolveDockerHome();
  const args = ["run"];

  if (options.detach) {
    args.push("-d");
  }
  if (options.interactive) {
    args.push("-i");
  }
  if (options.remove) {
    args.push("--rm");
  }

  args.push("--init");
  if (options.containerName) {
    args.push("--name", options.containerName);
  }
  args.push("--cpus", formatCpuLimit());
  args.push("--memory", env.DOCKER_EXECUTION_MEMORY);

  for (const port of options.publishPorts ?? []) {
    args.push("-p", port);
  }

  if (options.workdir) {
    args.push("-w", options.workdir);
  }

  args.push("-v", "/etc/passwd:/etc/passwd:ro");
  args.push("-v", "/etc/group:/etc/group:ro");
  args.push(
    "-v",
    `${env.DOCKER_EXECUTION_MOUNT_ROOT}:${env.DOCKER_EXECUTION_MOUNT_ROOT}`
  );

  pushDockerEnv(args, "HOME", home);
  pushDockerEnv(args, "CODEX_HOME_DIR", `${home}/.codex`);
  pushDockerEnv(args, "PATH", resolveDockerPath(home));

  appendProcessEnvKeys(args, ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"]);
  appendProcessEnvPrefixes(args, options.passthroughEnvPrefixes ?? []);

  if (process.env.SSH_AUTH_SOCK) {
    args.push("-v", `${process.env.SSH_AUTH_SOCK}:${process.env.SSH_AUTH_SOCK}`);
    pushDockerEnv(args, "SSH_AUTH_SOCK", process.env.SSH_AUTH_SOCK);
  }

  if (process.env.XDG_RUNTIME_DIR) {
    pushDockerEnv(args, "XDG_RUNTIME_DIR", process.env.XDG_RUNTIME_DIR);
  }

  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }

  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    pushDockerEnv(args, key, value);
  }

  args.push(env.DOCKER_EXECUTION_IMAGE, ...options.command);
  return args;
}

export class DockerCommandRunner {
  private ensureImagePromise: Promise<void> | undefined;

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike
  ) {}

  async ensureImage(): Promise<void> {
    if (!this.ensureImagePromise) {
      this.ensureImagePromise = this.doEnsureImage().finally(() => {
        this.ensureImagePromise = undefined;
      });
    }

    await this.ensureImagePromise;
  }

  async run(
    args: string[],
    options?: {
      allowFailure?: boolean;
      timeoutMs?: number;
    }
  ): Promise<CommandResult> {
    this.logger?.info(
      {
        command: shellCommandPreview(args)
      },
      "执行 docker 命令"
    );

    const result = await new Promise<CommandResult>((resolve, reject) => {
      const invocation = resolveDockerCommandInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timeout =
        typeof options?.timeoutMs === "number" && options.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeoutMs)
          : undefined;
      child.on("error", reject);
      child.on("close", (exitCode) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (timedOut) {
          stderr = [stderr.trim(), `docker 命令执行超时（${options?.timeoutMs}ms）`]
            .filter(Boolean)
            .join("\n");
        }
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1
        });
      });
    }).catch((error) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1
    }));

    if (result.exitCode !== 0 && !options?.allowFailure) {
      throw new Error(normalizeDockerCommandError(args, result));
    }

    return result;
  }

  private async doEnsureImage(): Promise<void> {
    const inspectResult = await this.run(["image", "inspect", this.env.DOCKER_EXECUTION_IMAGE], {
      allowFailure: true
    });
    if (inspectResult.exitCode === 0) {
      return;
    }

    this.logger?.info(
      {
        image: this.env.DOCKER_EXECUTION_IMAGE
      },
      "docker 执行池镜像不存在，准备本地构建"
    );
    await this.run([
      "build",
      "--target",
      "runtime",
      "-t",
      this.env.DOCKER_EXECUTION_IMAGE,
      process.cwd()
    ]);
  }
}
