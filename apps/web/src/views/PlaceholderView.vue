<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { NCard, NEmpty, NTag } from 'naive-ui';

const route = useRoute();
const title = computed(() => String(route.meta.title ?? '未实现模块'));
const stage = computed(() => String(route.meta.stage ?? '后续阶段'));
const description = computed(() => String(route.meta.description ?? '该模块将在后续阶段实现。'));
</script>

<template>
  <n-card :title="title">
    <template #header-extra><n-tag :bordered="false">{{ stage }}</n-tag></template>
    <n-empty :description="description">
      <template #extra>
        <p class="empty-copy">当前页面保留真实空状态，不展示虚构项目、金额或进度。</p>
      </template>
    </n-empty>
  </n-card>
</template>
