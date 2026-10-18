<template>
  <BaseDialog :show="show" :title="t('providerRuntime.manage')" width="wide" @close="emit('close')">
    <ProviderRuntimeAccountForm v-if="show" :account-id="accountId" :initial-group-id="groupId" @saved="emit('saved')" />
  </BaseDialog>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import ProviderRuntimeAccountForm from './ProviderRuntimeAccountForm.vue'

defineProps<{ show: boolean; accountId?: string; groupId?: number }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useI18n()
</script>
