<script setup lang="ts">
import { NCard, NEmpty, NGrid, NGridItem, NStatistic, NTag } from 'naive-ui';
import type { CurrentUser } from '@tpm/shared';

defineProps<{ currentUser: CurrentUser }>();
</script>

<template>
  <div class="view-stack">
    <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen">
      <n-grid-item><n-card><n-statistic label="项目需求" value="—" /><small class="muted">P2 接入真实需求池</small></n-card></n-grid-item>
      <n-grid-item><n-card><n-statistic label="储备项目" value="—" /><small class="muted">P3 接入储备转换</small></n-card></n-grid-item>
      <n-grid-item><n-card><n-statistic label="实施待办" value="—" /><small class="muted">P5 接入实施状态</small></n-card></n-grid-item>
      <n-grid-item><n-card><n-statistic label="资金预警" value="—" /><small class="muted">P4 / P6 接入资金规则</small></n-card></n-grid-item>
    </n-grid>

    <n-card title="当前开发状态">
      <template #header-extra><n-tag type="success" :bordered="false">P1.2 认证重构</n-tag></template>
      <n-empty description="尚未导入正式业务数据">
        <template #extra>
          <p class="empty-copy">当前只展示已实现能力。需求、储备、出库、实施、结算和资金数据不会使用硬编码样本冒充正式结果。</p>
        </template>
      </n-empty>
    </n-card>

    <n-card title="当前身份">
      <div class="identity-summary">
        <div><span>成员</span><strong>{{ currentUser.displayName }}</strong></div>
        <div><span>角色</span><strong>{{ currentUser.role }}</strong></div>
        <div><span>授权范围</span><strong>{{ currentUser.scopes.length ? currentUser.scopes.length + ' 项' : '未配置' }}</strong></div>
        <div><span>登录账号</span><strong>@{{ currentUser.username }}</strong></div>
      </div>
    </n-card>
  </div>
</template>
