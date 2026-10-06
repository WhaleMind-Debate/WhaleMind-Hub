/**
 * @debate/shared — 前后端共享契约入口
 * 所有 Socket / 状态 Payload 的类型定义集中在 types/debate.ts，
 * client 通过 @/types/debate.ts re-export，server 直接引用本包。
 */
export * from './types/debate.js';
export * from './templates.js';
