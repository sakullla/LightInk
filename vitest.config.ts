import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // R7：并行执行降低全量测试时长。vmThreads 保持 isolate:true，用 VM 隔离
    // 替代每文件 OS 线程，以降低 130 文件的 environment/import 墙钟。
    pool: 'vmThreads',
    maxWorkers: 8,
    // 8 worker 满载时重型 jsdom 用例（阅读器加载/漫画生命周期等单测空载即
    // 0.7~4.6s）会被 CPU 争抢拖长数倍，曾接连撞默认 5s 单测超时（门禁全量跑
    // 时序脆弱、逐用例打补丁不可枚举）；统一放宽到 20s 留足裕量。
    testTimeout: 20_000,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: { enabled: false },
  },
});
