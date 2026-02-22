/**
 * 定时任务服务
 * 用于执行周期性的定时任务
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';

export class SchedulerService {
    private ctx: NapCatPluginContext;
    private intervalId: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;

    constructor(ctx: NapCatPluginContext) {
        this.ctx = ctx;
    }

    /**
     * 启动定时任务
     */
    start(): void {
        if (this.isRunning) {
            this.ctx.logger.warn('定时任务已在运行中');
            return;
        }

        this.ctx.logger.info('启动定时任务服务');

        // 每10秒执行一次
        this.intervalId = setInterval(() => {
            this.executeTask();
        }, 10000);

        // 立即执行一次
        this.executeTask();

        this.isRunning = true;
    }

    /**
     * 停止定时任务
     */
    stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.ctx.logger.info('停止定时任务服务');

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        this.isRunning = false;
    }

    /**
     * 执行定时任务
     */
    private executeTask(): void {
        const now = new Date().toLocaleString('zh-CN');
        this.ctx.logger.info(`[定时任务] 当前时间: ${now}`);
    }

    /**
     * 获取运行状态
     */
    getStatus(): boolean {
        return this.isRunning;
    }
}

// 单例实例
let schedulerInstance: SchedulerService | null = null;

/**
 * 初始化并启动定时任务服务
 */
export function startScheduler(ctx: NapCatPluginContext): SchedulerService {
    if (!schedulerInstance) {
        schedulerInstance = new SchedulerService(ctx);
    }
    schedulerInstance.start();
    return schedulerInstance;
}

/**
 * 停止定时任务服务
 */
export function stopScheduler(): void {
    if (schedulerInstance) {
        schedulerInstance.stop();
        schedulerInstance = null;
    }
}

/**
 * 获取定时任务服务实例
 */
export function getScheduler(): SchedulerService | null {
    return schedulerInstance;
}
