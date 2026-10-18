import { describe, expect, it } from 'vitest'
import { buildRuntimeAccounts, type RuntimeAccount, type RuntimeModel } from '../providerRuntime'

const account: RuntimeAccount = { id: 'fixture-account', name: 'Fixture', provider: 'workbuddy', connected: true, models: [] }
describe('provider runtime account import', () => {
  it('groups models by their native protocol without embedding subscription credentials', () => {
    const models: RuntimeModel[] = [
      { id: 'chat-a', name: 'Chat A', protocol: 'chat_completions', context: 1000 },
      { id: 'chat-b', name: 'Chat B', protocol: 'chat_completions', context: 2000 },
      { id: 'responses-a', name: 'Responses', protocol: 'responses', context: 3000 },
      { id: 'messages-a', name: 'Messages', protocol: 'anthropic', context: 4000 }
    ]
    const result = buildRuntimeAccounts(account, models, 42)
    expect(result).toHaveLength(3)
    expect(result[0].credentials.model_mapping).toEqual({ 'chat-a': 'chat-a', 'chat-b': 'chat-b' })
    for (const item of result) {
      expect(item.platform).toBe('openai')
      expect(item.type).toBe('apikey')
      expect(item.group_ids).toEqual([42])
      expect(item.credentials.provider_runtime_account).toBe('fixture-account')
      expect(item.credentials.base_url).toBe('https://provider-runtime.invalid')
      expect(item.credentials).not.toHaveProperty('access_token')
      expect(item.credentials).not.toHaveProperty('refresh_token')
    }
  })
  it('preserves an unassigned group and the public provider concurrency limit', () => {
    const result = buildRuntimeAccounts({ ...account, provider: 'opencode-zen-free' }, [
      { id: 'free', name: 'Free', protocol: 'chat_completions', context: null }
    ])
    expect(result[0].group_ids).toEqual([])
    expect(result[0].concurrency).toBe(2)
  })
  it('does not import empty or unsupported model protocols', () => {
    expect(buildRuntimeAccounts(account, [
      { id: '', name: 'Empty', protocol: 'responses', context: null },
      { id: 'invalid', name: 'Invalid', protocol: 'systemone' as RuntimeModel['protocol'], context: null }
    ])).toEqual([])
  })
})
