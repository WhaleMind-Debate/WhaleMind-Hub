import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true, // 监听局域网，评委手机可直连
    port: 5173,
    proxy: {
      // 开发期把 Socket.io 代理到后端，客户端可同源连接
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
