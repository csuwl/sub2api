import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin } from '@magpie-community/opencode-workbuddy-auth';
import { ZenFreePlugin } from '@magpie-community/opencode-zen-free-auth';

// Only operator-installed, pinned providers execute. There is no remote npm
// install or arbitrary module/path selection in the management API.
export const providers = {
  workbuddy: { name: 'WorkBuddy', factory: WorkBuddyAuthPlugin, streamOnly: true, protocol: 'chat_completions' },
  'workbuddy-ai': { name: 'WorkBuddy AI', factory: WorkBuddyAIAuthPlugin, streamOnly: true, protocol: 'chat_completions' },
  'opencode-zen-free': { name: 'OpenCode Zen Free', factory: ZenFreePlugin, protocol: 'chat_completions', publicAuth: true },
};

export function modelList(config, fallbackProtocol) {
  return Object.entries(config.models ?? {}).map(([id, model]) => {
    const npm = model.provider?.npm ?? model.npm ?? config.npm ?? '';
    const protocol = npm.includes('anthropic') ? 'anthropic'
      : npm === '@ai-sdk/openai' ? 'responses' : fallbackProtocol;
    return { id, name: model.name ?? id, protocol, context: model.limit?.context ?? model.contextWindow ?? null };
  });
}
