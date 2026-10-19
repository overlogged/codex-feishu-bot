import { findConfiguredModel, normalizeName, normalizeProvider } from "../../services/provider-catalog.js";
import { applyAcpBindingSettings, type ConfigurableAcpSession } from "./acp-binding-settings.js";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function route(value: unknown): { provider: string; model: string } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch { /* Older ACP servers may use plain model IDs. */ }
  return undefined;
}

function choices(items: unknown[]): Record<string, unknown>[] {
  return items.flatMap((item) => record(item)
    ? Array.isArray(item.options) ? choices(item.options) : [item]
    : []);
}

/** DSH exposes one model selector whose opaque values encode [provider, model]. */
export async function applyDshModelSelection(
  session: ConfigurableAcpSession,
  settings: { provider?: string; model?: string }
): Promise<void> {
  if (!settings.provider && !settings.model) return;
  const option = session.configOptions.find((item) => record(item) && (item.category === "model" || item.id === "model"));
  const advertised = record(option) && Array.isArray(option.options) ? choices(option.options) : [];
  const routes = advertised.flatMap((choice) => {
    const parsed = route(choice.value);
    return parsed ? [{ ...parsed, value: choice.value as string, name: choice.name }] : [];
  });
  // Preserve compatibility with servers advertising separate provider/model selectors.
  if (!record(option) || typeof option.id !== "string" || routes.length === 0) {
    await applyAcpBindingSettings(session, settings);
    return;
  }

  const provider = normalizeProvider("dsh", settings.provider);
  const entry = settings.model ? findConfiguredModel("dsh", settings.model) : undefined;
  const model = entry?.id ?? settings.model;
  const current = route(option.currentValue);
  let matches = routes.filter((candidate) => {
    if (provider && candidate.provider !== provider) return false;
    if (!model) return true;
    const requested = entry?.providerModels[candidate.provider] ?? model;
    return candidate.value === model || normalizeName(candidate.model) === normalizeName(requested) ||
      (typeof candidate.name === "string" && normalizeName(candidate.name) === normalizeName(requested));
  });
  // A provider-only change keeps the current model if that route is available.
  if (!model && current) {
    const currentEntry = findConfiguredModel("dsh", current.model);
    const sameModel = matches.filter((candidate) => candidate.model ===
      (currentEntry?.providerModels[candidate.provider] ?? currentEntry?.id ?? current.model));
    if (sameModel.length) matches = sameModel;
  }
  // A model-only change stays with the current provider when possible.
  if (!provider && matches.length > 1 && current) {
    const sameProvider = matches.filter((candidate) => candidate.provider === current.provider);
    if (sameProvider.length) matches = sameProvider;
  }
  if (matches.length !== 1) {
    const available = routes.filter((candidate) => !provider || candidate.provider === provider)
      .map((candidate) => `${candidate.provider}/${candidate.model}`).join("、");
    throw new Error(`DSH ${matches.length ? "模型选择不唯一，请指定 provider 和模型" : "不支持所选 provider/模型"}：${provider ?? "默认"}/${model ?? "默认"}。可选：${available || "该 provider 未提供可用模型，请检查 dsh 登录和配置"}`);
  }
  await session.setConfigOption(option.id, matches[0]!.value);
}
