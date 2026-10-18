import { apiClient } from '../client'
import type { CreateAccountRequest } from '@/types'

export type RuntimeProtocol = 'chat_completions' | 'responses' | 'anthropic'
export interface RuntimeModel { id: string; name: string; protocol: RuntimeProtocol; context: number | null }
export interface RuntimeAccount { id: string; name: string; provider: string; connected: boolean; models: RuntimeModel[] }
export interface RuntimeProvider { id: string; name: string }
export interface RuntimeLogin { status: 'pending' | 'connected' | 'disconnected' | 'error'; url?: string; instructions?: string; message?: string }

export async function runtimeRequest<T>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
  const { data } = await apiClient.request<T>({ url: `/admin/provider-runtime${path}`, method, data: body })
  return data
}

// One Sub2API account per native protocol allows the existing conversion paths
// to serve all clients while keeping provider authentication in the host.
export function buildRuntimeAccounts(account: RuntimeAccount, models: RuntimeModel[], groupId?: number): CreateAccountRequest[] {
  const byProtocol = new Map<RuntimeProtocol, RuntimeModel[]>()
  for (const model of models) {
    if (!['chat_completions', 'responses', 'anthropic'].includes(model.protocol) || !model.id.trim()) continue
    byProtocol.set(model.protocol, [...(byProtocol.get(model.protocol) ?? []), model])
  }
  return [...byProtocol].map(([protocol, members]) => ({
    name: `${account.name} · ${protocol}`,
    platform: 'openai', type: 'apikey', concurrency: account.provider === 'opencode-zen-free' ? 2 : 4,
    group_ids: groupId ? [groupId] : [],
    credentials: {
      base_url: 'https://provider-runtime.invalid', api_key: 'provider-runtime',
      provider_runtime_account: account.id, provider_runtime_provider: account.provider,
      provider_runtime_protocol: protocol,
      model_mapping: Object.fromEntries(members.map(model => [model.id, model.id]))
    },
    extra: { openai_responses_supported: protocol === 'responses' }
  }))
}
