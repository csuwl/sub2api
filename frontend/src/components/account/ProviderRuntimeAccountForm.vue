<template>
    <div class="space-y-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-sm text-gray-500">{{ t('providerRuntime.description') }}</p>
        </div>
        <button class="btn btn-secondary" :disabled="busy" @click="load">{{ t('providerRuntime.refresh') }}</button>
      </div>
      <p v-if="error" role="alert" class="rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20">{{ error }}</p>
      <p v-if="!enabled" class="card p-5 text-gray-600 dark:text-gray-300">{{ t('providerRuntime.disabled') }}</p>
      <template v-else>
        <form v-if="!accountId" class="card flex flex-wrap items-end gap-4 p-5" @submit.prevent="add">
          <label class="min-w-48 flex-1"><span class="input-label">{{ t('providerRuntime.provider') }}</span>
            <select v-model="provider" class="input"><option v-for="item in providers" :key="item.id" :value="item.id">{{ item.name }}</option></select>
          </label>
          <label class="min-w-48 flex-1"><span class="input-label">{{ t('providerRuntime.name') }}</span><input v-model="name" class="input" :placeholder="t('providerRuntime.namePlaceholder')" maxlength="100" required /><span class="text-xs text-gray-500">{{ t('providerRuntime.nameHint') }}</span></label>
          <p class="w-full text-sm text-gray-600 dark:text-gray-300">{{ t(isPublicProvider ? 'providerRuntime.publicHint' : 'providerRuntime.browserHint') }}</p>
          <button class="btn btn-primary" :disabled="busy || !provider">{{ t(isPublicProvider ? 'providerRuntime.addPublic' : 'providerRuntime.addAndAuthorize') }}</button>
        </form>
        <section v-if="accounts.length" class="card space-y-4 p-5">
          <label class="block"><span class="input-label">{{ t('providerRuntime.account') }}</span>
            <select v-model="selectedId" class="input" :disabled="busy" @change="restoreSelection"><option v-for="item in accounts" :key="item.id" :value="item.id">{{ item.name }} · {{ item.provider === 'opencode-zen-free' ? t('providerRuntime.publicAccess') : item.connected ? t('providerRuntime.connected') : t('providerRuntime.disconnected') }}</option></select>
          </label>
          <p v-if="selected?.provider === 'opencode-zen-free'" class="rounded-lg bg-blue-50 p-4 text-sm dark:bg-blue-900/20">{{ t('providerRuntime.publicHint') }}</p>
          <p v-else-if="selected && !selected.connected" class="text-sm text-gray-600 dark:text-gray-300">{{ t('providerRuntime.browserHint') }}</p>
          <div v-if="selected" class="flex flex-wrap gap-3">
            <button v-if="selected.provider !== 'opencode-zen-free'" class="btn btn-secondary" :disabled="busy || login?.status === 'pending'" @click="authorize">{{ t('providerRuntime.connect') }}</button>
            <button class="btn btn-secondary" :disabled="busy || !selected.connected" @click="loadModels">{{ t('providerRuntime.loadModels') }}</button>
            <button class="btn btn-secondary" :disabled="busy || !selected.connected" @click="loadUsage">{{ t('providerRuntime.usage') }}</button>
          </div>
          <div v-if="login?.status === 'pending'" class="rounded-lg bg-blue-50 p-4 dark:bg-blue-900/20">
            <p>{{ t('providerRuntime.pending') }}</p>
            <a v-if="loginURL" :href="loginURL" target="_blank" rel="noopener noreferrer" class="btn btn-primary mt-3 inline-flex">{{ t('providerRuntime.openLogin') }}</a>
            <p class="mt-2 text-sm">{{ t('providerRuntime.remoteHint') }}</p>
          </div>
          <p v-if="login?.status === 'connected' && selected?.provider !== 'opencode-zen-free'" role="status" class="text-green-700">{{ t('providerRuntime.authorized') }}</p>
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
            <button class="btn btn-primary" :disabled="busy || !selected.connected || !chosen.length" @click="importModels">{{ t('providerRuntime.import') }}</button>
            <p v-if="imported !== null" role="status" class="text-green-700">{{ t('providerRuntime.imported', { count: imported }) }}</p>
          </template>
        </section>
      </template>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import * as accountAPI from '@/api/admin/accounts'
import * as groupAPI from '@/api/admin/groups'
import { buildRuntimeAccounts, runtimeRequest, type RuntimeAccount, type RuntimeLogin, type RuntimeModel, type RuntimeProvider } from '@/api/admin/providerRuntime'
import type { AdminGroup, AccountListItem } from '@/types'

const { t } = useI18n()
const props = defineProps<{ providerId?: string; accountId?: string; accountName?: string; initialGroupId?: number }>()
const emit = defineEmits<{ saved: [] }>()
const enabled = ref(true), busy = ref(false), error = ref('')
const providers = ref<RuntimeProvider[]>([]), accounts = ref<RuntimeAccount[]>([])
const provider = ref(props.providerId ?? ''), name = ref(props.accountName ?? ''), selectedId = ref(props.accountId ?? '')
const selected = computed(() => accounts.value.find(account => account.id === selectedId.value))
const isPublicProvider = computed(() => provider.value === 'opencode-zen-free')
const models = ref<RuntimeModel[]>([]), chosen = ref<string[]>([]), groups = ref<AdminGroup[]>([])
const groupId = ref<number | undefined>(props.initialGroupId), imported = ref<number | null>(null), login = ref<RuntimeLogin>()
const allowance = ref<{ plan?: string; error?: string; windows?: { name: string; used?: number; limit?: number }[] }>()
const loginURL = computed(() => { try { const url = new URL(login.value?.url ?? ''); return url.protocol === 'https:' ? url.href : '' } catch { return '' } })
let timer: ReturnType<typeof setTimeout> | undefined
let mounted = true

function stopPolling() { if (timer) clearTimeout(timer); timer = undefined }
function resetSelection() { stopPolling(); login.value = undefined; allowance.value = undefined; imported.value = null; models.value = selected.value?.models ?? []; chosen.value = models.value.map(model => model.id) }
async function restoreSelection() {
  resetSelection()
  const id = selectedId.value
  if (!id || selected.value?.provider === 'opencode-zen-free') return
  await poll(id)
}
async function run(action: () => Promise<void>) {
  busy.value = true; error.value = ''
  try { await action() } catch (failure) { error.value = failure instanceof Error ? failure.message : t('providerRuntime.error') }
  finally { busy.value = false }
}
async function load() { await run(async () => {
  enabled.value = (await runtimeRequest<{ enabled: boolean }>('/status')).enabled
  if (!enabled.value) return
  const [providerList, accountList, groupList] = await Promise.all([runtimeRequest<RuntimeProvider[]>('/providers'), runtimeRequest<RuntimeAccount[]>('/accounts'), groupAPI.getAll('openai')])
  providers.value = providerList.filter(item => !props.providerId || item.id === props.providerId)
  accounts.value = accountList.filter(item => (!props.accountId || item.id === props.accountId) && (!props.providerId || item.provider === props.providerId))
  groups.value = groupList
  provider.value ||= providers.value[0]?.id ?? ''
  if (!accounts.value.some(item => item.id === selectedId.value)) selectedId.value = accounts.value[0]?.id ?? ''
  await restoreSelection()
}) }
async function add() { await run(async () => {
  const account = await runtimeRequest<RuntimeAccount>('/accounts', 'POST', { provider: provider.value, name: name.value })
  accounts.value.push(account); selectedId.value = account.id; name.value = ''; resetSelection()
  // Discovery follows public authorization without an extra management page.
  if (account.connected) {
    const result = await runtimeRequest<RuntimeModel[]>(`/accounts/${account.id}/models`, 'POST', {})
    models.value = result; chosen.value = result.map(model => model.id)
  } else {
    await startAuthorization(account.id)
  }
}) }
async function poll(id: string) {
  if (!mounted || selectedId.value !== id) return
  try {
    const state = await runtimeRequest<RuntimeLogin>(`/accounts/${id}/poll`)
    if (!mounted || selectedId.value !== id) return
    login.value = { ...login.value, ...state }
    if (state.status === 'pending') timer = setTimeout(() => void poll(id), 1500)
    else if (state.status === 'connected' && selected.value) {
      const newlyAuthorized = !selected.value.connected
      selected.value.connected = true
      if (newlyAuthorized || !models.value.length) await loadModels()
    }
    else if (state.status === 'error') error.value = state.message ?? t('providerRuntime.error')
  } catch { if (mounted && selectedId.value === id) error.value = t('providerRuntime.error') }
}
async function startAuthorization(id: string) {
  const authorization = await runtimeRequest<RuntimeLogin>(`/accounts/${id}/authorize`, 'POST', {})
  if (!mounted || selectedId.value !== id) return
  login.value = authorization
  if (login.value.status === 'pending') { stopPolling(); timer = setTimeout(() => void poll(id), 1500) }
  else if (login.value.status === 'connected' && selected.value?.id === id) {
    selected.value.connected = true
    const result = await runtimeRequest<RuntimeModel[]>(`/accounts/${id}/models`, 'POST', {})
    models.value = result; chosen.value = result.map(model => model.id)
  } else if (login.value.status === 'error') throw new Error(login.value.message ?? t('providerRuntime.error'))
}
async function authorize() { await run(() => startAuthorization(selectedId.value)) }
async function loadModels() { const id = selectedId.value; await run(async () => {
  const result = await runtimeRequest<RuntimeModel[]>(`/accounts/${id}/models`, 'POST', {})
  if (selectedId.value !== id) return
  models.value = result; chosen.value = result.map(model => model.id); imported.value = null
}) }
async function loadUsage() { const id = selectedId.value; await run(async () => { const result = await runtimeRequest<typeof allowance.value>(`/accounts/${id}/usage`); if (selectedId.value === id) allowance.value = result }) }
async function importModels() {
  const account = selected.value
  if (!account?.connected) { error.value = t('providerRuntime.authorizeFirst'); return }
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
        const oldGroups = previous.group_ids ?? []
        const addGroup = groupId.value !== undefined && !oldGroups.includes(groupId.value)
        if (Object.keys(newMapping).some(id => !(id in oldMapping)) || addGroup) {
          await accountAPI.update(previous.id, { credentials: { ...previous.credentials, model_mapping: { ...oldMapping, ...newMapping } },
            ...(addGroup ? { group_ids: [...oldGroups, groupId.value!] } : {}) })
          count++
        }
        continue
      }
      await accountAPI.create(request); count++
    }
    imported.value = count
    emit('saved')
  })
}
onMounted(() => { void load() })
onBeforeUnmount(() => { mounted = false; stopPolling() })
</script>
