import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import type { Env } from "./config/env.js";
import { CodexAppServerWorker } from "./integrations/codex/app-server-worker.js";
import { ClaudeCliWorker } from "./integrations/codex/claude-cli-worker.js";
import type { CodexWorker } from "./integrations/codex/codex-worker.js";
import { DshAcpWorker } from "./integrations/codex/dsh-acp-worker.js";
import { KimiAcpWorker } from "./integrations/codex/kimi-acp-worker.js";
import { MockCodexWorker } from "./integrations/codex/mock-codex-worker.js";
import { PiRpcWorker, PI_DS_FLASH_MODEL } from "./integrations/codex/pi-rpc-worker.js";
import { MultiCliWorker } from "./integrations/codex/multi-cli-worker.js";
import { KimiQuotaClient } from "./integrations/kimi/kimi-quota-client.js";
import { FakeFeishuMessageClient } from "./integrations/feishu/fake-feishu-message-client.js";
import { FakeFeishuWsSubscriber } from "./integrations/feishu/fake-feishu-ws-subscriber.js";
import {
  createFeishuOpenApiClient,
  hasFeishuCredentials
} from "./integrations/feishu/feishu-openapi-client.js";
import { FeishuSessionMetadataProvider } from "./integrations/feishu/feishu-session-metadata-provider.js";
import { ConsoleFeishuMessageClient } from "./integrations/feishu/feishu-message-client.js";
import type { FeishuMessageClient } from "./integrations/feishu/feishu-message-client.js";
import { FeishuSdkMessageClient } from "./integrations/feishu/feishu-sdk-message-client.js";
import { FeishuWsSubscriber } from "./integrations/feishu/feishu-ws-subscriber.js";
import { registerAgentManagerRoutes } from "./routes/agent-manager.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerFeishuRoutes } from "./routes/feishu.js";
import { registerHealthRoutes } from "./routes/health.js";
import { AgentManagerService } from "./services/agent-manager-service.js";
import { ChatScheduleService } from "./services/chat-schedule-service.js";
import { ChatOrchestrator } from "./services/chat-orchestrator.js";
import { CodexGroupControlAgent } from "./services/group-control-agent.js";
import { FileBackedChatWorkspaceResolver } from "./services/chat-workspace-resolver.js";
import { ConversationDeliveryService } from "./services/conversation-delivery-service.js";
import { MessageProjector } from "./services/message-projector.js";
import { UsageStatsService } from "./services/usage-stats-service.js";
import { TokenDailyReportService } from "./services/token-daily-report-service.js";
import { ConversationStore } from "./stores/conversation-store.js";
import { RunStore } from "./stores/run-store.js";
import { RuntimeStatePersister } from "./stores/runtime-state-persister.js";
import { ScheduledTaskStore } from "./stores/scheduled-task-store.js";
import { SessionStore } from "./stores/session-store.js";
import { UsageSnapshotStore } from "./stores/usage-snapshot-store.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

function buildCodexWorker(env: Env, logger: LoggerLike): CodexWorker {
  if (env.CODEX_MODE === "app-server") {
    return new MultiCliWorker({
      codex: new CodexAppServerWorker(env, logger),
      claude: new ClaudeCliWorker(env, logger),
      kimi: new KimiAcpWorker(env, logger),
      pi: new PiRpcWorker(env, logger),
      dsh: new DshAcpWorker(env, logger)
    });
  }

  return new MockCodexWorker();
}

function buildFeishuMessageClient(
  env: Env,
  logger: LoggerLike,
  client?: ReturnType<typeof createFeishuOpenApiClient>
): FeishuMessageClient {
  if (env.FEISHU_PROVIDER === "fake") {
    return new FakeFeishuMessageClient(env.FAKE_FEISHU_BASE_URL);
  }

  if (!hasFeishuCredentials(env)) {
    return new ConsoleFeishuMessageClient();
  }

  return new FeishuSdkMessageClient(client ?? createFeishuOpenApiClient(env), logger);
}

export interface AppRuntime {
  app: FastifyInstance;
  startExternalServices(): Promise<void>;
  stopExternalServices(): Promise<void>;
}

export function buildAppRuntime(env: Env): AppRuntime {
  const app = Fastify({
    logger: true
  });

  const runtimeStatePersister = new RuntimeStatePersister(
    env.RUNTIME_STATE_FILE,
    app.log
  );
  let sessionStore: SessionStore;
  let runStore: RunStore;
  let conversationStore: ConversationStore;
  let scheduledTaskStore: ScheduledTaskStore;
  const persistRuntimeState = () => runtimeStatePersister.scheduleSave();

  sessionStore = new SessionStore(persistRuntimeState);
  runStore = new RunStore(persistRuntimeState);
  conversationStore = new ConversationStore(persistRuntimeState);
  scheduledTaskStore = new ScheduledTaskStore(persistRuntimeState);
  runtimeStatePersister.attach({
    sessionStore,
    runStore,
    conversationStore,
    scheduledTaskStore
  });
  const feishuOpenApiClient =
    env.FEISHU_PROVIDER === "fake" || !hasFeishuCredentials(env)
      ? undefined
      : createFeishuOpenApiClient(env);
  const feishuClient = buildFeishuMessageClient(env, app.log, feishuOpenApiClient);
  const workspaceResolver = new FileBackedChatWorkspaceResolver(
    env.DEFAULT_WORKSPACE,
    env.CHAT_WORKSPACE_BINDINGS_FILE,
    app.log
  );
  const deliveryService = new ConversationDeliveryService(
    feishuClient,
    conversationStore,
    env.LIVE_UPDATE_DEBOUNCE_MS,
    app.log,
    (item) => sessionStore.get(item.chatId)?.toolCardsEnabled === true
  );
  const scheduleService = new ChatScheduleService(scheduledTaskStore, app.log);
  const projector = new MessageProjector(runStore, conversationStore);
  const codexWorker = buildCodexWorker(env, app.log);
  const groupControlAgent = new CodexGroupControlAgent(
    codexWorker,
    env.DEFAULT_WORKSPACE,
    app.log,
    "pi",
    PI_DS_FLASH_MODEL
  );
  const usageSnapshotStore = new UsageSnapshotStore(env.USAGE_SNAPSHOT_FILE, app.log);
  const usageStatsService = new UsageStatsService(
    codexWorker,
    {
      ccusageCommand: env.CCUSAGE_COMMAND,
      cacheMs: env.USAGE_CCUSAGE_CACHE_MS,
      usdToCnyRate: env.USAGE_USD_TO_CNY_RATE,
      snapshotIntervalMs: env.USAGE_SNAPSHOT_INTERVAL_MS
    },
    app.log,
    undefined,
    new KimiQuotaClient({
      credentialsFile: env.KIMI_CODE_CREDENTIALS_FILE,
      logger: app.log
    }),
    usageSnapshotStore
  );
  const tokenDailyReportService = new TokenDailyReportService(
    sessionStore,
    usageStatsService,
    (chatId, content) => feishuClient.sendText({ chatId, content }).then(() => undefined),
    app.log,
    {
      defaultTime: env.TOKEN_DAILY_REPORT_TIME
    }
  );
  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    feishuClient,
    deliveryService,
    projector,
    codexWorker,
    workspaceResolver,
    scheduleService,
    env.DEFAULT_WORKSPACE,
    app.log,
    groupControlAgent,
    {
      codex: "codex",
      kimi: env.KIMI_ACP_COMMAND,
      claude: env.CLAUDE_CLI_COMMAND,
      pi: env.PI_CLI_COMMAND
    },
    usageStatsService,
    env.TOKEN_DAILY_REPORT_TIME
  );
  const agentManager = new AgentManagerService(
    env.DEFAULT_WORKSPACE,
    sessionStore,
    runStore,
    conversationStore,
    feishuClient,
    orchestrator,
    feishuOpenApiClient ? new FeishuSessionMetadataProvider(feishuOpenApiClient, app.log) : undefined
  );

  void registerHealthRoutes(app);
  void registerAgentManagerRoutes(app, {
    agentManager
  });
  void registerDebugRoutes(app, {
    orchestrator
  });
  void registerFeishuRoutes(app, {
    orchestrator
  });

  const wsSubscriber =
    env.FEISHU_TRANSPORT !== "websocket"
      ? undefined
      : env.FEISHU_PROVIDER === "fake"
        ? new FakeFeishuWsSubscriber({
            env,
            logger: app.log,
            onMessage: (message) => {
              orchestrator.enqueue(message);
            }
          })
        : hasFeishuCredentials(env)
          ? new FeishuWsSubscriber({
              env,
              logger: app.log,
              onMessage: (message) => {
                orchestrator.enqueue(message);
              }
            })
          : undefined;

  return {
    app,
    async startExternalServices() {
      await mkdir(env.CODEX_ARTIFACTS_DIR, {
        recursive: true
      });
      await mkdir(dirname(env.RUNTIME_STATE_FILE), {
        recursive: true
      });
      const restored = await runtimeStatePersister.restore({
        sessionStore,
        runStore,
        conversationStore,
        scheduledTaskStore
      });
      await runtimeStatePersister.flush();

      app.log.info(
        {
          host: env.HOST,
          port: env.PORT,
          codexMode: env.CODEX_MODE,
          codexManaged: env.CODEX_APP_SERVER_MANAGED,
          codexListenUrl: env.CODEX_APP_SERVER_LISTEN_URL,
          codexModel: env.CODEX_APP_SERVER_MODEL,
          codexModelReasoningEffort: env.CODEX_APP_SERVER_MODEL_REASONING_EFFORT,
          feishuProvider: env.FEISHU_PROVIDER,
          feishuTransport: env.FEISHU_TRANSPORT,
          feishuDomain: env.FEISHU_DOMAIN,
          hasFeishuCredentials: hasFeishuCredentials(env),
          defaultWorkspace: env.DEFAULT_WORKSPACE,
          codexArtifactsDir: env.CODEX_ARTIFACTS_DIR,
          runtimeStateFile: env.RUNTIME_STATE_FILE,
          scheduledTasks: scheduledTaskStore.list().length
        },
        "应用启动配置摘要"
      );
      await usageSnapshotStore.load();
      usageStatsService.start();
      tokenDailyReportService.start();
      await codexWorker.start?.();
      scheduleService.start((task) => orchestrator.triggerScheduledTask(task));

      if (restored.interruptedRuns.length > 0) {
        const interruptedByChat = new Map<string, number>();
        for (const run of restored.interruptedRuns) {
          interruptedByChat.set(run.chatId, (interruptedByChat.get(run.chatId) ?? 0) + 1);
        }

        for (const [chatId, count] of interruptedByChat) {
          const content =
            count > 1
              ? `服务器刚刚重启，这个群里有 ${count} 个进行中的任务被中断了。要继续的话，直接回复“继续”，也可以顺手补一句要我接着做什么。`
              : "服务器刚刚重启，之前这个群里的任务被中断了。要继续的话，直接回复“继续”，也可以顺手补一句要我接着做什么。";

          try {
            await feishuClient.sendText({
              chatId,
              content
            });
            app.log.info(
              {
                chatId,
                interruptedRuns: count
              },
              "已向受影响群发送重启中断提示"
            );
          } catch (error) {
            app.log.error(
              {
                chatId,
                interruptedRuns: count,
                error: error instanceof Error ? error.message : String(error)
              },
              "向受影响群发送重启中断提示失败"
            );
          }
        }
      }

      if (env.FEISHU_TRANSPORT !== "websocket") {
        app.log.info("飞书事件入口未使用 WebSocket 模式");
        return;
      }

      if (env.FEISHU_PROVIDER !== "fake" && !hasFeishuCredentials(env)) {
        app.log.warn("缺少飞书凭证，跳过 WebSocket 建连");
        return;
      }

      await wsSubscriber?.start();
    },
    async stopExternalServices() {
      await wsSubscriber?.close();
      tokenDailyReportService.stop();
      usageStatsService.stop();
      scheduleService.stop();
      await codexWorker.close?.();
      await runtimeStatePersister.flush();
    }
  };
}
