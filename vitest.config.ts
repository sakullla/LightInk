import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // R7：并行执行降低全量测试时长。vmThreads 保持 isolate:true，用 VM 隔离
    // 替代每文件 OS 线程，以降低 130 文件的 environment/import 墙钟。
    pool: 'vmThreads',
    maxWorkers: 8,
    setupFiles: ['./vitest.setup.ts'],
    coverage: { enabled: false },
  },
});
