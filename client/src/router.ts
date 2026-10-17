import { createRouter, createWebHistory } from 'vue-router';

/**
 * 路由：
 * - /admin  主席控制台（PC）
 * - /judge  评委打分端（移动/平板）
 * - /screen 大屏展示端（舞台投屏）
 * - /board  比分后台（历史场次列表）
 * - /board/:matchId 赛后报告（单场成绩单）
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/admin' },
    { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue') },
    { path: '/judge', name: 'judge', component: () => import('./views/JudgeView.vue') },
    { path: '/screen', name: 'screen', component: () => import('./views/ScreenView.vue') },
    { path: '/board', name: 'board', component: () => import('./views/BoardView.vue') },
    {
      path: '/board/:matchId',
      name: 'match-report',
      component: () => import('./views/MatchReportView.vue'),
    },
  ],
});
