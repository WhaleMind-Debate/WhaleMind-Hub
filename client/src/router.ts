import { createRouter, createWebHistory } from 'vue-router';

/**
 * 三端路由：
 * - /admin  主席控制台（PC）
 * - /judge  评委打分端（移动/平板）
 * - /screen 大屏展示端（舞台投屏）
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/admin' },
    { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue') },
    { path: '/judge', name: 'judge', component: () => import('./views/JudgeView.vue') },
    { path: '/screen', name: 'screen', component: () => import('./views/ScreenView.vue') },
  ],
});
