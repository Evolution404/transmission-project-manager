<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NEmpty, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui';
import type {
  BackupSummary,
  MemberSummary,
  NotificationContactSummary,
  NotificationOutboxSummary,
} from '@tpm/shared';
import { apiRequest, jsonRequestInit } from '../../api/client';

const props = defineProps<{ members: MemberSummary[] }>();
const message = useMessage();
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const contacts = ref<NotificationContactSummary[]>([]);
const outbox = ref<NotificationOutboxSummary[]>([]);
const backups = ref<BackupSummary[]>([]);
const selectedMemberId = ref<string | null>(props.members[0]?.id ?? null);
const contactAddress = ref('');

const memberOptions = computed(() => props.members.map((member) => ({
  label: `${member.displayName} · @${member.username}`,
  value: member.id,
})));

const deliveryStateLabels: Record<string, string> = {
  pending: '待发送',
  leased: '发送中',
  sent: '已发送',
  failed: '发送失败',
  unknown: '结果待确认',
};
const backupStateLabels: Record<string, string> = {
  pending: '待执行',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
};

watch(() => props.members, (members) => {
  if (!selectedMemberId.value && members[0]) selectedMemberId.value = members[0].id;
}, { deep: true });

function businessToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function statusType(status: string) {
  if (['completed', 'sent'].includes(status)) return 'success' as const;
  if (['failed'].includes(status)) return 'error' as const;
  if (['running', 'leased'].includes(status)) return 'info' as const;
  return 'warning' as const;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [contactData, outboxData, backupData] = await Promise.all([
      apiRequest<{ items: NotificationContactSummary[] }>('/api/notification-contacts'),
      apiRequest<{ items: NotificationOutboxSummary[] }>('/api/notification-outbox'),
      apiRequest<{ items: BackupSummary[] }>('/api/backups'),
    ]);
    contacts.value = contactData.items;
    outbox.value = outboxData.items;
    backups.value = backupData.items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取通知与备份状态失败';
  } finally {
    loading.value = false;
  }
}

async function refreshAfterCommittedWrite(successMessage: string, refresh: () => Promise<unknown>) {
  try {
    await refresh();
    error.value = '';
    message.success(successMessage);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : '读取最新数据失败';
    error.value = `${successMessage}，但最新数据刷新失败：${detail}`;
    message.warning(`${successMessage}，但最新数据刷新失败，请重新加载`);
  }
}

async function refreshContacts() {
  contacts.value = (await apiRequest<{ items: NotificationContactSummary[] }>('/api/notification-contacts')).items;
}

async function refreshBackups() {
  backups.value = (await apiRequest<{ items: BackupSummary[] }>('/api/backups')).items;
}

async function createContact() {
  const memberId = selectedMemberId.value;
  const address = contactAddress.value.trim();
  if (!memberId) { message.warning('请选择成员'); return; }
  if (!address) { message.warning('请输入通知地址'); return; }
  saving.value = true;
  try {
    await apiRequest('/api/notification-contacts', jsonRequestInit('POST', {
      memberId, address, verified: true, enabled: true,
    }));
    contactAddress.value = '';
    await refreshAfterCommittedWrite('通知地址已保存', refreshContacts);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '通知地址保存失败');
  } finally {
    saving.value = false;
  }
}

async function createBackup() {
  saving.value = true;
  try {
    await apiRequest('/api/backups', jsonRequestInit('POST', { backupDate: businessToday(), kind: 'daily' }));
    await refreshAfterCommittedWrite('备份任务已创建', refreshBackups);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '备份创建失败');
  } finally {
    saving.value = false;
  }
}

async function stepBackup(item: BackupSummary) {
  try {
    await apiRequest(`/api/backups/${item.id}/step`, jsonRequestInit('POST', {}));
    await refreshAfterCommittedWrite('备份任务已推进', refreshBackups);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '备份推进失败');
  }
}

async function verifyBackup(item: BackupSummary) {
  try {
    await apiRequest(`/api/backups/${item.id}/verify`, jsonRequestInit('POST', {}));
    await refreshAfterCommittedWrite('完整性校验完成', refreshBackups);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '备份校验失败');
  }
}

onMounted(load);
</script>

<template>
  <section class="section-panel operations-panel" data-test="system-operations">
    <div class="section-panel-header">
      <div>
        <h3>通知与备份</h3>
        <p>集中管理通知联系人、发送结果与逻辑备份；这些运维能力不再混入业务分析页面。</p>
      </div>
    </div>
    <div class="section-panel-body operations-body">
      <div v-if="error" class="operation-error">{{ error }} <n-button text @click="load">重新加载</n-button></div>
      <n-spin :show="loading">
        <div class="operations-grid">
          <section class="operation-group">
            <div class="operation-heading">
              <div><strong>通知联系人</strong><small>直接选择真实成员，不手工填写内部标识。</small></div>
            </div>
            <div class="contact-form">
              <n-select v-model:value="selectedMemberId" :options="memberOptions" placeholder="选择成员" filterable />
              <n-input v-model:value="contactAddress" placeholder="通知地址" />
              <n-button :loading="saving" @click="createContact">保存地址</n-button>
            </div>
            <div v-if="contacts.length" class="compact-records">
              <div v-for="item in contacts" :key="item.id" class="record-row">
                <span>{{ item.address }}</span>
                <n-tag size="small" :bordered="false" :type="item.verifiedAt ? 'success' : 'warning'">{{ item.verifiedAt ? '已验证' : '待验证' }}</n-tag>
              </div>
            </div>
            <n-empty v-else description="暂无通知联系人" />
          </section>

          <section class="operation-group">
            <div class="operation-heading"><div><strong>通知发送记录</strong><small>只展示当前发送状态和重试次数。</small></div></div>
            <div v-if="outbox.length" class="compact-records">
              <div v-for="item in outbox" :key="item.id" class="record-row record-row-wide">
                <span>{{ item.recipient }}</span>
                <span class="record-meta">尝试 {{ item.attemptCount }} 次</span>
                <n-tag size="small" :bordered="false" :type="statusType(item.status)">{{ deliveryStateLabels[item.status] ?? '未知状态' }}</n-tag>
              </div>
            </div>
            <n-empty v-else description="暂无通知发送记录" />
          </section>

          <section class="operation-group backup-group">
            <div class="operation-heading">
              <div><strong>逻辑备份</strong><small>按表分片保存并支持完整性校验；恢复必须在隔离环境验证。</small></div>
              <n-button :loading="saving" @click="createBackup">创建今日备份</n-button>
            </div>
            <div v-if="backups.length" class="backup-list">
              <div v-for="item in backups" :key="item.id" class="backup-row">
                <div class="backup-main"><strong>{{ item.backupDate }}</strong><small>{{ item.kind === 'monthly' ? '月度保留' : '日常备份' }} · {{ item.chunkCount }} 个分片</small></div>
                <n-tag size="small" :bordered="false" :type="statusType(item.status)">{{ backupStateLabels[item.status] ?? '未知状态' }}</n-tag>
                <div class="backup-actions">
                  <n-button v-if="item.status !== 'completed'" size="small" @click="stepBackup(item)">继续执行</n-button>
                  <n-button v-else size="small" :type="item.verifiedAt ? 'success' : 'default'" secondary @click="verifyBackup(item)">{{ item.verifiedAt ? '重新校验' : '校验完整性' }}</n-button>
                </div>
              </div>
            </div>
            <n-empty v-else description="暂无备份记录" />
          </section>
        </div>
      </n-spin>
    </div>
  </section>
</template>

<style scoped>
.operations-body { padding: 0; }
.operation-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px; padding: 10px 12px; border-radius: 10px; background: var(--ui-danger-soft); color: var(--ui-danger); font-size: 13px; }
.operations-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.operation-group { min-width: 0; padding: 18px; }
.operation-group:nth-child(2) { border-left: 1px solid var(--ui-border); }
.backup-group { grid-column: 1 / -1; border-top: 1px solid var(--ui-border); }
.operation-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.operation-heading > div { display: grid; gap: 3px; }
.operation-heading strong { color: var(--ui-text); font-size: 13px; font-weight: 680; }
.operation-heading small { color: var(--ui-text-tertiary); font-size: 13px; line-height: 1.45; }
.contact-form { display: grid; grid-template-columns: minmax(180px, .9fr) minmax(220px, 1.1fr) auto; gap: 8px; margin-bottom: 14px; }
.compact-records, .backup-list { display: grid; border-top: 1px solid var(--ui-border); }
.record-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; min-height: 44px; border-bottom: 1px solid var(--ui-border); color: var(--ui-text-secondary); font-size: 13px; }
.record-row:last-child, .backup-row:last-child { border-bottom: 0; }
.record-row-wide { grid-template-columns: minmax(0, 1fr) auto auto; }
.record-meta { color: var(--ui-text-tertiary); font-size: 13px; }
.backup-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 14px; align-items: center; min-height: 62px; padding: 8px 0; border-bottom: 1px solid var(--ui-border); }
.backup-main { display: grid; gap: 3px; }
.backup-main strong { font-size: 13px; font-weight: 650; }
.backup-main small { color: var(--ui-text-tertiary); font-size: 13px; }
.backup-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 900px) {
  .operations-grid { grid-template-columns: 1fr; }
  .operation-group:nth-child(2) { border-left: 0; border-top: 1px solid var(--ui-border); }
  .backup-group { grid-column: auto; }
  .contact-form { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .operation-group { padding: 14px; }
  .operation-heading { align-items: flex-start; flex-direction: column; }
  .record-row-wide, .backup-row { grid-template-columns: 1fr auto; }
  .record-row-wide .record-meta, .backup-actions { grid-column: 1 / -1; }
  .backup-actions { justify-content: flex-start; }
}
</style>
