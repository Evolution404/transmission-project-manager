import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView, meta: { title: '总览', navKey: '/' } },
    { path: '/demands', name: 'demands', component: () => import('./views/DemandsView.vue'), meta: { title: '项目需求', navKey: '/demands' } },
    { path: '/projects', name: 'projects', component: () => import('./views/ProjectsView.vue'), meta: { title: '项目', navKey: '/projects' } },
    { path: '/projects/:projectId', name: 'project-detail', component: () => import('./views/ProjectDetailView.vue'), meta: { title: '项目详情', navKey: '/projects' } },
    { path: '/projects/:projectId/tasks/new', name: 'task-create', component: () => import('./views/TaskCreateView.vue'), meta: { title: '新建执行任务', navKey: '/tasks' } },
    { path: '/projects/:projectId/tasks/:taskId', name: 'task-detail', component: () => import('./views/TaskDetailView.vue'), meta: { title: '任务详情', navKey: '/tasks' } },
    { path: '/reserves', redirect: '/projects' },
    { path: '/tasks', name: 'tasks', component: () => import('./views/TaskQueueView.vue'), meta: { title: '执行任务', navKey: '/tasks' } },
    { path: '/delivery', redirect: '/tasks' },
    { path: '/finance', name: 'finance', component: () => import('./views/FinanceView.vue'), meta: { title: '资金管理', navKey: '/finance' } },
    { path: '/analysis', name: 'analysis', component: () => import('./views/AnalysisView.vue'), meta: { title: '业务分析', navKey: '/analysis' } },
    { path: '/master-data', name: 'master-data', component: () => import('./views/MasterDataView.vue'), meta: { title: '基础台账', navKey: '/master-data' } },
    {
      path: '/administration',
      name: 'administration',
      component: () => import('./views/AdministrationView.vue'),
      meta: { title: '设置', navKey: '/administration' },
    },
  ],
});
