import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView, meta: { title: '总览' } },
    { path: '/demands', name: 'demands', component: () => import('./views/DemandsView.vue'), meta: { title: '项目需求' } },
    { path: '/reserves', name: 'reserves', component: () => import('./views/ReservesView.vue'), meta: { title: '项目储备' } },
    { path: '/delivery', name: 'delivery', component: () => import('./views/DeliveryView.vue'), meta: { title: '实施结算' } },
    { path: '/finance', name: 'finance', component: () => import('./views/FinanceView.vue'), meta: { title: '框架费用' } },
    { path: '/analysis', name: 'analysis', component: () => import('./views/AnalysisView.vue'), meta: { title: '储备分析' } },
    {
      path: '/administration',
      name: 'administration',
      component: () => import('./views/AdministrationView.vue'),
      meta: { title: '规则与成员' },
    },
  ],
});
