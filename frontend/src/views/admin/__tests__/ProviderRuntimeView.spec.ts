import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import en from '@/i18n/locales/en'
import ProviderRuntimeView from '../ProviderRuntimeView.vue'
import { runtimeRequest } from '@/api/admin/providerRuntime'
import * as accounts from '@/api/admin/accounts'

vi.mock('@/api/admin/providerRuntime', async original => ({ ...await original<typeof import('@/api/admin/providerRuntime')>(), runtimeRequest: vi.fn() }))
vi.mock('@/api/admin/accounts', () => ({ default: {}, list: vi.fn(), create: vi.fn(), update: vi.fn() }))
vi.mock('@/api/admin/groups', () => ({ default: {}, getAll: vi.fn(async () => [{ id: 42, name: 'Fixture group' }]) }))
vi.mock('@/components/layout/AppLayout.vue', () => ({ default: { template: '<main><slot /></main>' } }))
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
async function open() {
  wrapper = mount(ProviderRuntimeView, { global: {
    stubs: { AppLayout: { template: '<main><slot /></main>' } } } })
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
})
