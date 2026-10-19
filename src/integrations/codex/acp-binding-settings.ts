export interface ConfigurableAcpSession {
  configOptions: unknown[];
  setConfigOption(id: string, value: string): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only apply settings the ACP server actually advertises; never silently ignore a binding. */
export async function applyAcpBindingSettings(
  session: ConfigurableAcpSession,
  settings: { provider?: string; model?: string; thinking?: string }
): Promise<void> {
  for (const [field, value] of Object.entries(settings)) {
    if (!value) continue;
    const category = field === "thinking" ? "thought_level" : field;
    const option = session.configOptions.find((item) => record(item) &&
      (item.category === category || item.id === field || (field === "thinking" && item.id === "reasoning_effort")));
    if (!record(option) || typeof option.id !== "string") {
      throw new Error(`当前 ACP 后端未提供 ${field} 配置项，无法应用 ${value}；请使用该 CLI 的原生配置。`);
    }
    const flatten = (items: unknown[]): Record<string, unknown>[] => items.flatMap((item) =>
      record(item) ? (Array.isArray(item.options) ? flatten(item.options) : [item]) : []);
    const choices = flatten(Array.isArray(option.options) ? option.options : []);
    const matches = choices.filter((choice) => choice.value === value ||
      (typeof choice.name === "string" && choice.name.toLowerCase() === value.toLowerCase()));
    if (matches.length !== 1 || typeof matches[0]?.value !== "string") {
      throw new Error(`当前 ACP 后端不支持 ${field}=${value}。`);
    }
    await session.setConfigOption(option.id, matches[0].value);
  }
}
