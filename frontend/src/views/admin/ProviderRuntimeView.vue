<template>
  <AppLayout>
    <div class="space-y-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('providerRuntime.title') }}</h2>
          <p class="mt-1 text-sm text-gray-500">{{ t('providerRuntime.description') }}</p>
        </div>
        <button class="btn btn-secondary" :disabled="busy" @click="load">{{ t('providerRuntime.refresh') }}</button>
      </div>
      <p v-if="error" role="alert" class="rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20">{{ error }}</p>
      <p v-if="!enabled" class="card p-5 text-gray-600 dark:text-gray-300">{{ t('providerRuntime.disabled') }}</p>
      <template v-else>
        <form class="card flex flex-wrap items-end gap-4 p-5" @submit.prevent="add">
          <label class="min-w-48 flex-1"><span class="input-label">{{ t('providerRuntime.provider') }}</span>
            <select v-model="provider" class="input"><option v-for="item in providers" :key="item.id" :value="item.id">{{ item.name }}</option></select>
          </label>
          <label class="min-w-48 flex-1"><span class="input-label">{{ t('providerRuntime.name') }}</span><input v-model="name" class="input" maxlength="100" required /></label>
          <button class="btn btn-primary" :disabled="busy || !provider">{{ t('providerRuntime.add') }}</button>
        </form>
        <section class="card space-y-4 p-5">
          <label class="block"><span class="input-label">{{ t('providerRuntime.account') }}</span>
            <select v-model="selectedId" class="input"><option v-for="item in accounts" :key="item.id" :value="item.id">{{ item.name }} · {{ item.connected ? t('providerRuntime.connected') : t('providerRuntime.disconnected') }}</option></select>
          </label>
          <div v-if="selected" class="flex flex-wrap gap-3">
            <button class="btn btn-secondary" :disabled="busy || login?.status === 'pending'" @click="authorize">{{ t('providerRuntime.connect') }}</button>
            <button class="btn btn-secondary" :disabled="busy || !selected.connected" @click="loadModels">{{ t('providerRuntime.loadModels') }}</button>
            <button class="btn btn-secondary" :disabled="busy || !selected.connected" @click="loadUsage">{{ t('providerRuntime.usage') }}</button>
          </div>
          <div v-if="login?.status === 'pending'" class="rounded-lg bg-blue-50 p-4 dark:bg-blue-900/20">
            <p>{{ t('providerRuntime.pending') }}</p>
            <a v-if="loginURL" :href="loginURL" target="_blank" rel="noopener noreferrer" class="mt-2 inline-block text-primary-600 underline">{{ t('providerRuntime.openLogin') }}</a>
          </div>
          <div v-if="allowance" class="rounded-lg bg-gray-50 p-4 dark:bg-dark-700">
            <h3 class="font-medium">{{ t('providerRuntime.allowance') }}</h3>
            <p v-if="allowance.plan">{{ allowance.plan }}</p>
            <p v-if="allowance.error || !allowance.windows?.length">{{ allowance.error || t('providerRuntime.unknown') }}</p>
            <p v-for="(window, index) in allowance.windows" :key="index">{{ window.name }}: {{ window.used ?? '?' }} / {{ window.limit ?? '?' }}</p>
          </div>
        </section>
        <section v-if="selected" class="card space-y-4 p-5">
          <h3 class="font-semibold">{{ t('providerRuntime.models') }}</h3>
          <p v-if="!models.length" class="text-sm text-gray-500">{{ t('providerRuntime.empty') }}</p>
          <template v-else>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="chosen.length === models.length" @change="chosen = chosen.length === models.length ? [] : models.map(model => model.id)" />{{ t('providerRuntime.selectAll') }}</label>
            <div class="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-dark-700">
              <label v-for="model in models" :key="model.id" class="flex items-center gap-3 py-2">
                <input v-model="chosen" type="checkbox" :value="model.id" />
                <span class="flex-1">{{ model.name }} <span class="text-xs text-gray-500">{{ model.id }}</span></span>
                <span class="text-xs text-gray-500">{{ model.protocol }}</span>
              </label>
            </div>
            <label class="block"><span class="input-label">{{ t('providerRuntime.group') }}</span><select v-model="groupId" class="input"><option :value="undefined">{{ t('providerRuntime.unassigned') }}</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
            <p class="text-sm text-gray-500">{{ t('providerRuntime.importHint') }}</p>
            <p class="text-sm text-gray-500">{{ t('providerRuntime.pricingHint') }}</p>
            <button class="btn btn-primary" :disabled="busy || !chosen.length" @click="importModels">{{ t('providerRuntime.import') }}</button>
            <p v-if="imported !== null" role="status" class="text-green-700">{{ t('providerRuntime.imported', { count: imported }) }}</p>
          </template>
        </section>
      </template>
    </div>
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import * as accountAPI from '@/api/admin/accounts'
import * as groupAPI from '@/api/admin/groups'
import { buildRuntimeAccounts, runtimeRequest, type RuntimeAccount, type RuntimeLogin, type RuntimeModel, type RuntimeProvider } from '@/api/admin/providerRuntime'
import type { AdminGroup, AccountListItem } from '@/types'

const { t } = useI18n()
const enabled = ref(true), busy = ref(false), error = ref('')
const providers = ref<RuntimeProvider[]>([]), accounts = ref<RuntimeAccount[]>([])
const provider = ref(''), name = ref(''), selectedId = ref('')
const selected = computed(() => accounts.value.find(account => account.id === selectedId.value))
const models = ref<RuntimeModel[]>([]), chosen = ref<string[]>([]), groups = ref<AdminGroup[]>([])
const groupId = ref<number>(), imported = ref<number | null>(null), login = ref<RuntimeLogin>()
const allowance = ref<{ plan?: string; error?: string; windows?: { name: string; used?: number; limit?: number }[] }>()
const loginURL = computed(() => { try { const url = new URL(login.value?.url ?? ''); return url.protocol === 'https:' ? url.href : '' } catch { return '' } })
let timer: ReturnType<typeof setTimeout> | undefined
let mounted = true

function stopPolling() { if (timer) clearTimeout(timer); timer = undefined }
watch(selectedId, () => { stopPolling(); login.value = undefined; allowance.value = undefined; imported.value = null; models.value = selected.value?.models ?? []; chosen.value = models.value.map(model => model.id) })
async function run(action: () => Promise<void>) {
  busy.value = true; error.value = ''
  try { await action() } catch (failure) { error.value = failure instanceof Error ? failure.message : t('providerRuntime.error') }
  finally { busy.value = false }
}
async function load() { await run(async () => {
  enabled.value = (await runtimeRequest<{ enabled: boolean }>('/status')).enabled
  if (!enabled.value) return
  const [providerList, accountList, groupList] = await Promise.all([runtimeRequest<RuntimeProvider[]>('/providers'), runtimeRequest<RuntimeAccount[]>('/accounts'), groupAPI.getAll('openai')])
  providers.value = providerList; accounts.value = accountList; groups.value = groupList
  provider.value ||= providerList[0]?.id ?? ''; selectedId.value ||= accountList[0]?.id ?? ''
}) }
async function add() { await run(async () => {
  const account = await runtimeRequest<RuntimeAccount>('/accounts', 'POST', { provider: provider.value, name: name.value })
  accounts.value.push(account); selectedId.value = account.id; name.value = ''
}) }
async function poll(id: string) {
  if (!mounted || selectedId.value !== id) return
  try {
    const state = await runtimeRequest<RuntimeLogin>(`/accounts/${id}/poll`)
    if (!mounted || selectedId.value !== id) return
    login.value = { ...login.value, ...state }
    if (state.status === 'pending') timer = setTimeout(() => void poll(id), 1500)
    else if (state.status === 'connected' && selected.value) selected.value.connected = true
    else if (state.status === 'error') error.value = state.message ?? t('providerRuntime.error')
  } catch { if (mounted && selectedId.value === id) error.value = t('providerRuntime.error') }
}
async function authorize() { const id = selectedId.value; await run(async () => {
  login.value = await runtimeRequest<RuntimeLogin>(`/accounts/${id}/authorize`, 'POST', {})
  if (login.value.status === 'pending') { stopPolling(); timer = setTimeout(() => void poll(id), 1500) }
  else if (selected.value?.id === id) selected.value.connected = true
}) }
async function loadModels() { const id = selectedId.value; await run(async () => {
  const result = await runtimeRequest<RuntimeModel[]>(`/accounts/${id}/models`, 'POST', {})
  if (selectedId.value !== id) return
  models.value = result; chosen.value = result.map(model => model.id); imported.value = null
}) }
async function loadUsage() { const id = selectedId.value; await run(async () => { const result = await runtimeRequest<typeof allowance.value>(`/accounts/${id}/usage`); if (selectedId.value === id) allowance.value = result }) }
async function importModels() {
  const account = selected.value
  if (!account) return
  await run(async () => {
    const requests = buildRuntimeAccounts(account, models.value.filter(model => chosen.value.includes(model.id)), groupId.value)
    if (!requests.length) throw new Error(t('providerRuntime.selectModels'))
    const existing = new Map<string, AccountListItem>()
    let page = 1
    for (;;) {
      const result = await accountAPI.list(page, 100, { platform: 'openai' })
      for (const item of result.items) if (item.credentials?.provider_runtime_account === account.id) existing.set(String(item.credentials.provider_runtime_protocol), item)
      if (page >= result.pages) break
      page++
    }
    let count = 0
    for (const request of requests) {
      const previous = existing.get(String(request.credentials.provider_runtime_protocol))
      if (previous) {
        const oldMapping = (previous.credentials?.model_mapping ?? {}) as Record<string, unknown>
        const newMapping = request.credentials.model_mapping as Record<string, unknown>
        if (Object.keys(newMapping).some(id => !(id in oldMapping))) {
          await accountAPI.update(previous.id, { credentials: { ...previous.credentials, model_mapping: { ...oldMapping, ...newMapping } } })
          count++
        }
        continue
      }
      await accountAPI.create(request); count++
    }
    imported.value = count
  })
}
onMounted(() => { void load() })
onBeforeUnmount(() => { mounted = false; stopPolling() })
</script>
