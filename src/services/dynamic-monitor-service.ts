/**
 * 动态监控服务
 * 负责定时检查主播动态更新并发送通知
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { pluginState } from '../core/state';
import { storage } from '../core/storage';
import { createNotificationService, type NotificationService } from './notification-service';

/** 动态缓存 */
interface DynamicCache {
    lastDynamicId: string;
    lastCheckTime: number;
}

export class DynamicMonitorService {
    private ctx: NapCatPluginContext;
    private notificationService: NotificationService;
    private cronJob: ScheduledTask | null = null;
    private isRunning: boolean = false;
    private dynamicCache: Map<number, DynamicCache> = new Map();

    constructor(ctx: NapCatPluginContext) {
        this.ctx = ctx;
        this.notificationService = createNotificationService(ctx);
        this.loadCache();
    }

    /** 启动动态监控 */
    start(): void {
        if (this.isRunning) {
            this.ctx.logger.warn('动态监控已在运行中');
            return;
        }

        this.ctx.logger.info('启动动态监控服务');
        this.isRunning = true;

        // 立即执行一次检查
        this.checkAllStreamers();

        // 每分钟检查一次（动态更新频率不需要太高）
        this.cronJob = cron.schedule('0 * * * * *', () => {
            this.checkAllStreamers();
        });
    }

    /** 停止动态监控 */
    stop(): void {
        if (!this.isRunning) return;

        this.ctx.logger.info('停止动态监控服务');
        this.cronJob?.stop();
        this.cronJob = null;
        this.saveCache();
        this.isRunning = false;
    }

    /** 检查所有订阅的主播 */
    private async checkAllStreamers(): Promise<void> {
        try {
            const subscribedStreamers = storage.getAllStreamers()
                .filter(s => storage.hasAnySubscribers(s.uid));

            if (subscribedStreamers.length === 0) return;

            for (const streamer of subscribedStreamers) {
                await this.checkStreamerDynamic(streamer.uid);
            }

            this.saveCache();
        } catch (error) {
            this.ctx.logger.error('检查动态更新失败:', error);
        }
    }

    /** 检查单个主播的动态 */
    private async checkStreamerDynamic(uid: number): Promise<void> {
        const cache = this.dynamicCache.get(uid) ?? {
            lastDynamicId: '',
            lastCheckTime: 0,
        };

        // TODO: 调用B站API获取最新动态
        // const latestDynamic = await getLatestDynamic(uid);

        // TODO: 检测是否有新动态
        // if (cache.lastDynamicId && latestDynamic.id !== cache.lastDynamicId) {
        //     this.ctx.logger.info(`[新动态] ${streamer.uname}`);
        //     await this.sendDynamicNotification(streamer, latestDynamic);
        // }

        // TODO: 更新缓存
        // cache.lastDynamicId = latestDynamic.id;
        // cache.lastCheckTime = Date.now();
        // this.dynamicCache.set(uid, cache);
    }

    /** 发送动态通知 */
    private async sendDynamicNotification(uid: number, dynamic: unknown): Promise<void> {
        const streamer = storage.getStreamer(uid);
        if (!streamer) return;

        const message = `${streamer.uname} 发布了新动态！`;

        await this.notificationService.sendToSubscribers(uid, {
            text: message,
            // image: dynamic.images?.[0], // 如果有图片
        });
    }

    /** 加载缓存 */
    private loadCache(): void {
        const cache = pluginState.loadDataFile<Record<string, DynamicCache>>('dynamic_cache.json', {});
        for (const [uid, data] of Object.entries(cache)) {
            this.dynamicCache.set(Number(uid), data);
        }
    }

    /** 保存缓存 */
    private saveCache(): void {
        const data: Record<string, DynamicCache> = {};
        for (const [uid, cache] of this.dynamicCache) {
            data[uid] = cache;
        }
        pluginState.saveDataFile('dynamic_cache.json', data);
    }

    getStatus(): boolean {
        return this.isRunning;
    }
}

// 单例
let instance: DynamicMonitorService | null = null;

export function startDynamicMonitor(ctx: NapCatPluginContext): DynamicMonitorService {
    if (!instance) {
        instance = new DynamicMonitorService(ctx);
    }
    instance.start();
    return instance;
}

export function stopDynamicMonitor(): void {
    instance?.stop();
    instance = null;
}

export function getDynamicMonitor(): DynamicMonitorService | null {
    return instance;
}
