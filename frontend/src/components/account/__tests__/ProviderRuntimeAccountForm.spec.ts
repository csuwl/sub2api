import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import en from '@/i18n/locales/en'
import ProviderRuntimeAccountForm from '../ProviderRuntimeAccountForm.vue'
import { runtimeRequest } from '@/api/admin/providerRuntime'
import * as accounts from '@/api/admin/accounts'

vi.mock('@/api/admin/providerRuntime', async original => ({ ...await original<typeof import('@/api/admin/providerRuntime')>(), runtimeRequest: vi.fn() }))
vi.mock('@/api/admin/accounts', () => ({ default: {}, list: vi.fn(), create: vi.fn(), update: vi.fn() }))
vi.mock('@/api/admin/groups', () => ({ default: {}, getAll: vi.fn(async () => [{ id: 42, name: 'Fixture group' }]) }))
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => {
  let message = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], en)
  if (typeof message !== 'string') return key
  for (const [name, value] of Object.entries(values ?? {})) message = (message as string).replaceAll(`{${name}}`, String(value))
  return message
} }) }))

const models = [{ id: 'glm-fixture', name: 'Fixture model', protocol: 'chat_completions', context: 1000 }]
const fixtureAccount = { id: 'fixture-account', name: 'Fixture account', provider: 'workbuddy', connected: true, models }
let wrapper: VueWrapper | undefined
const button = (label: string) => wrapper!.findAll('button').find(item => item.text() === label)!

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtimeRequest).mockImplementation(async path => {
    if (path === '/status') return { enabled: true } as never
    if (path === '/providers') return [{ id: 'workbuddy', name: 'WorkBuddy' }] as never
    if (path === '/accounts') return [structuredClone(fixtureAccount)] as never
    if (path.endsWith('/models')) return models as never
    if (path.endsWith('/authorize')) return { status: 'pending', url: 'https://fixture.invalid/login' } as never
    if (path.endsWith('/poll')) return { status: 'connected' } as never
    throw new Error(`Unexpected fixture operation: ${path}`)
  })
  vi.mocked(accounts.list).mockResolvedValue({ items: [], pages: 1, page: 1, page_size: 100, total: 0 })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers() })
async function open(props: { providerId?: string; accountId?: string } = {}) {
  wrapper = mount(ProviderRuntimeAccountForm, { props })
  await flushPromises()
}

describe('subscription provider management', () => {
  it('shows disabled configuration without querying provider accounts', async () => {
    vi.mocked(runtimeRequest).mockResolvedValue({ enabled: false } as never)
    await open()
    expect(wrapper!.text()).toContain('not enabled')
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it('imports selected native models with an opaque provider handle', async () => {
    await open()
    await button('Add models to Sub2API').trigger('click')
    await flushPromises()
    expect(accounts.create).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'openai', type: 'apikey', credentials: expect.objectContaining({
        provider_runtime_account: 'fixture-account', provider_runtime_protocol: 'chat_completions',
        model_mapping: { 'glm-fixture': 'glm-fixture' }
      })
    }))
    expect(wrapper!.text()).toContain('Added 1 accounts')
    expect(wrapper!.emitted('saved')).toHaveLength(1)
  })

  it('merges newly selected models into an existing connection without duplicating it', async () => {
    vi.mocked(accounts.list).mockResolvedValue({ items: [{ id: 7, credentials: {
      provider_runtime_account: 'fixture-account', provider_runtime_protocol: 'chat_completions',
      model_mapping: { previous: 'previous' }
    } }] as never, pages: 1, page: 1, page_size: 100, total: 1 })
    await open()
    await button('Add models to Sub2API').trigger('click')
    await flushPromises()
    expect(accounts.create).not.toHaveBeenCalled()
    expect(accounts.update).toHaveBeenCalledWith(7, { credentials: expect.objectContaining({
      model_mapping: { previous: 'previous', 'glm-fixture': 'glm-fixture' }
    }) })
  })

  it('links to the official authorization page and polls until connected', async () => {
    vi.useFakeTimers()
    await open()
    await button('Authorize account').trigger('click')
    await flushPromises()
    expect(wrapper!.find('a').attributes('href')).toBe('https://fixture.invalid/login')
    expect(wrapper!.find('a').attributes('rel')).toContain('noopener')
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(runtimeRequest).toHaveBeenCalledWith('/accounts/fixture-account/poll')
    expect(wrapper!.text()).not.toContain('Waiting for provider authorization')
  })

  it('opens an existing account with its saved models and no creation form', async () => {
    await open({ accountId: fixtureAccount.id })
    expect(wrapper!.find('form').exists()).toBe(false)
    expect(wrapper!.text()).toContain('Fixture model')
    expect(wrapper!.find('select').element.value).toBe(fixtureAccount.id)
  })

  it('keeps provider choices and resumable authorizations within the selected platform', async () => {
    vi.mocked(runtimeRequest).mockImplementation(async path => {
      if (path === '/status') return { enabled: true } as never
      if (path === '/providers') return [{ id: 'workbuddy', name: 'WorkBuddy' }, { id: 'opencode-zen-free', name: 'OpenCode Zen Free' }] as never
      if (path === '/accounts') return [fixtureAccount, { ...fixtureAccount, id: 'free-account', provider: 'opencode-zen-free', name: 'Free account' }] as never
      throw new Error(`Unexpected fixture operation: ${path}`)
    })
    await open({ providerId: 'opencode-zen-free' })
    const selects = wrapper!.findAll('select')
    expect(selects[0]!.findAll('option').map(option => option.text())).toEqual(['OpenCode Zen Free'])
    expect(selects[1]!.element.value).toBe('free-account')
    expect(selects[1]!.findAll('option')).toHaveLength(1)
  })

  it('adds a group without removing existing connection groups', async () => {
    vi.mocked(accounts.list).mockResolvedValue({ items: [{ id: 7, group_ids: [11, 12], credentials: {
      provider_runtime_account: fixtureAccount.id, provider_runtime_protocol: 'chat_completions', model_mapping: { 'glm-fixture': 'glm-fixture' }
    } }] as never, pages: 1, page: 1, page_size: 100, total: 1 })
    await open()
    await wrapper!.findAll('select').at(-1)!.setValue('42')
    await button('Add models to Sub2API').trigger('click'); await flushPromises()
    expect(accounts.update).toHaveBeenCalledWith(7, expect.objectContaining({ group_ids: [11, 12, 42] }))
    expect(accounts.create).not.toHaveBeenCalled()
  })

  it('creates a personal account, requires the official browser flow, then enables import', async () => {
    vi.useFakeTimers()
    const pending = { ...fixtureAccount, id: 'new-personal', connected: false, models: [] }
    vi.mocked(runtimeRequest).mockImplementation(async (path, method) => {
      if (path === '/status') return { enabled: true } as never
      if (path === '/providers') return [{ id: 'workbuddy', name: 'WorkBuddy' }] as never
      if (path === '/accounts') return (method === 'POST' ? pending : []) as never
      if (path.endsWith('/authorize')) return { status: 'pending', url: 'https://fixture.invalid/official-login' } as never
      if (path.endsWith('/poll')) return { status: 'connected' } as never
      if (path.endsWith('/models')) return models as never
      throw new Error(`Unexpected operation ${path}`)
    })
    await open({ providerId: 'workbuddy' })
    await wrapper!.find('input[maxlength]').setValue('My personal account')
    await wrapper!.find('form').trigger('submit')
    await flushPromises()
    expect(runtimeRequest).toHaveBeenCalledWith('/accounts/new-personal/authorize', 'POST', {})
    expect(wrapper!.find('a').attributes('href')).toBe('https://fixture.invalid/official-login')
    expect(wrapper!.text()).toContain('Waiting for provider authorization')
    expect(accounts.create).not.toHaveBeenCalled()
    expect(runtimeRequest).not.toHaveBeenCalledWith('/accounts/new-personal/models', 'POST', {})
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(runtimeRequest).toHaveBeenCalledWith('/accounts/new-personal/models', 'POST', {})
    expect(button('Add models to Sub2API').attributes('disabled')).toBeUndefined()
  })

  it('restores an unfinished login after reopening instead of losing its URL', async () => {
    vi.useFakeTimers()
    const original = vi.mocked(runtimeRequest).getMockImplementation()!
    vi.mocked(runtimeRequest).mockImplementation(async (path, ...args) => {
      if (path.endsWith('/poll')) return { status: 'pending', url: 'https://fixture.invalid/resume' } as never
      return original(path, ...args)
    })
    await open({ accountId: fixtureAccount.id })
    expect(wrapper!.find('a').attributes('href')).toBe('https://fixture.invalid/resume')
    await vi.advanceTimersByTimeAsync(1500)
    expect(runtimeRequest).toHaveBeenCalledWith('/accounts/fixture-account/poll')
  })

  it('does not treat an authorization error or stale model catalog as authenticated', async () => {
    const original = vi.mocked(runtimeRequest).getMockImplementation()!
    vi.mocked(runtimeRequest).mockImplementation(async (path, ...args) => {
      if (path === '/accounts') return [{ ...fixtureAccount, connected: false }] as never
      if (path.endsWith('/poll')) return { status: 'disconnected' } as never
      if (path.endsWith('/authorize')) return { status: 'error', message: 'Official sign-in failed' } as never
      return original(path, ...args)
    })
    await open()
    expect(button('Add models to Sub2API').attributes('disabled')).toBeDefined()
    await button('Authorize account').trigger('click'); await flushPromises()
    expect(wrapper!.text()).toContain('Official sign-in failed')
    expect(button('Add models to Sub2API').attributes('disabled')).toBeDefined()
    expect(accounts.create).not.toHaveBeenCalled()
  })

  it('explains public access without pretending to sign in to an email account', async () => {
    const original = vi.mocked(runtimeRequest).getMockImplementation()!
    vi.mocked(runtimeRequest).mockImplementation(async (path, ...args) => {
      if (path === '/providers') return [{ id: 'opencode-zen-free', name: 'OpenCode Zen Free' }] as never
      if (path === '/accounts') return [{ ...fixtureAccount, provider: 'opencode-zen-free' }] as never
      return original(path, ...args)
    })
    await open({ providerId: 'opencode-zen-free' })
    expect(wrapper!.text()).toContain('No sign-in is required')
    expect(wrapper!.text()).toContain('Entering an email does not sign in')
    expect(wrapper!.findAll('button').some(item => item.text() === 'Authorize account')).toBe(false)
    expect(runtimeRequest).not.toHaveBeenCalledWith('/accounts/fixture-account/authorize', 'POST', {})
  })
})
