import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import PlaceholderView from './views/PlaceholderView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView, meta: { title: '总览' } },
    { path: '/demands', name: 'demands', component: () => import('./views/DemandsView.vue'), meta: { title: '项目需求' } },
    { path: '/reserves', name: 'reserves', component: () => import('./views/ReservesView.vue'), meta: { title: '储备出库' } },
    { path: '/delivery', name: 'delivery', component: PlaceholderView, meta: { title: '实施结算', stage: 'P5', description: '实施记录、结算覆盖和四状态反馈将在 P5 实现。' } },
    { path: '/finance', name: 'finance', component: () => import('./views/FinanceView.vue'), meta: { title: '框架费用' } },
    { path: '/analysis', name: 'analysis', component: PlaceholderView, meta: { title: '储备分析', stage: 'P6', description: '分类分析、月报和预警将在 P6 实现。' } },
    {
      path: '/administration',
      name: 'administration',
      component: () => import('./views/AdministrationView.vue'),
      meta: { title: '规则与成员' },
    },
  ],
});
