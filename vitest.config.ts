import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // R7：并行执行降低全量测试时长。threads 池并行执行测试文件，保持默认
    // isolate:true 以确保 vi.mock 与 node/jsdom 混合环境的跨文件隔离。
    pool: 'threads',
    maxWorkers: 8,
    coverage: { enabled: false },
  },
});
