import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径，构建产物可以直接丢到任意静态目录 / GitHub Pages 子路径下
  base: './',
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
});
