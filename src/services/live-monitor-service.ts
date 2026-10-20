/**
 * 直播监控服务
 * 负责定时检查主播直播状态并发送开播/下播通知
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { pluginState } from '../core/state';
import { storage } from '../core/storage';
import type { Streamer } from '../core/storage';
import { getLiveRoomStatusBatch } from './bilibili-service';
import type { LiveRoomStatus } from '../types';
import { createNotificationService, type NotificationService } from './notification-service';

/** 主播直播状态缓存 */
interface StreamerLiveCache {
    lastLiveStatus: number;
    lastLiveTime: number;
}

export class LiveMonitorService {
    private ctx: NapCatPluginContext;
    private notificationService: NotificationService;
    private cronJob: ScheduledTask | null = null;
    private isRunning: boolean = false;
    private liveCache: Map<number, StreamerLiveCache> = new Map();
    private inFlight: Promise<void> | null = null;
    private controller: AbortController | null = null;

    constructor(ctx: NapCatPluginContext) {
        this.ctx = ctx;
        this.notificationService = createNotificationService(ctx);
        this.loadCache();
    }

    /** 启动直播监控 */
    start(): void {
        if (this.isRunning) {
            this.ctx.logger.warn('直播监控已在运行中');
            return;
        }

        this.ctx.logger.info('启动直播监控服务');
        this.isRunning = true;

        // 立即执行一次检查
        void this.checkAllStreamers();

        // 每10秒检查一次
        this.cronJob = cron.schedule('*/10 * * * * *', () => {
            void this.checkAllStreamers();
        });
    }

    /** 停止直播监控 */
    async stop(): Promise<void> {
        this.isRunning = false;
        this.cronJob?.stop();
        for (const [id, task] of cron.getTasks()) {
            if (task === this.cronJob) {
                cron.getTasks().delete(id);
                task.removeAllListeners();
                break;
            }
        }
        this.cronJob = null;
        this.controller?.abort();
        await this.inFlight;
        this.saveCache();
    }

    /** 检查所有订阅的主播 */
    private checkAllStreamers(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        if (!this.isRunning || !pluginState.config.enabled) return Promise.resolve();
        const controller = new AbortController();
        this.controller = controller;
        this.inFlight = this.runCheck(controller.signal).catch(error => {
            if (!controller.signal.aborted) this.ctx.logger.error('检查主播状态失败:', error);
        }).finally(() => {
            this.inFlight = null;
            this.controller = null;
        });
        return this.inFlight;
    }

    private async runCheck(signal: AbortSignal): Promise<void> {
        await this.notificationService.flush(signal);
        if (signal.aborted || !pluginState.config.enabled) return;
        const subscribedStreamers = storage.getAllStreamers().filter(streamer =>
            storage.getStreamerEnabledGroups(streamer.uid).length > 0
            || storage.getStreamerSubscribedUsers(streamer.uid).length > 0
        );
        if (subscribedStreamers.length === 0) return;
        const statusMap = await getLiveRoomStatusBatch(subscribedStreamers.map(streamer => streamer.uid), signal);
        if (signal.aborted || !pluginState.config.enabled) return;
        const updates: Streamer[] = [];
        for (const streamer of subscribedStreamers) {
            const status = statusMap.get(streamer.uid);
            if (!status) continue;
            const updated = {
                ...streamer, liveStatus: status.liveStatus, liveTime: status.liveTime,
                roomId: status.roomId, title: status.title, cover: status.cover,
                face: status.face, uname: status.uname,
            };
            this.processStreamerStatus(updated, status);
            updates.push(updated);
        }
        if (updates.length > 0) storage.setStreamers(updates);
        this.saveCache();
        await this.notificationService.flush(signal);
    }

    /** 处理单个主播的状态变化 */
    private processStreamerStatus(streamer: Streamer, status: LiveRoomStatus): void {
        const cache = this.liveCache.get(streamer.uid) ?? {
            lastLiveStatus: 0,
            lastLiveTime: 0,
        };

        const oldStatus = cache.lastLiveStatus;
        const currentStatus = status.liveStatus;


        // 检测状态变化：0=未开播, 1=直播中, 2=轮播中
        const wasLive = oldStatus === 1;
        const isLive = currentStatus === 1;

        if (!wasLive && isLive) {
            // 开播
            this.ctx.logger.info(`[开播] ${streamer.uname} (UID: ${streamer.uid})`);
            this.enqueueLiveStartNotification(streamer, status);
            cache.lastLiveTime = status.liveTime;
        } else if (wasLive && !isLive) {
            // 下播
            this.ctx.logger.info(`[下播] ${streamer.uname} (UID: ${streamer.uid})`);
            this.enqueueLiveEndNotification(streamer, cache.lastLiveTime);
        }

        // 更新缓存
        cache.lastLiveStatus = currentStatus;
        this.liveCache.set(streamer.uid, cache);
    }

    /** 发送开播通知 */
    private enqueueLiveStartNotification(streamer: Streamer, status: LiveRoomStatus): void {
        const message = [
            `【开播提醒】`,
            `${streamer.uname} 开播啦！`,
            `标题：${status.title}`,
            `分区: ${status.parentAreaName} - ${status.areaName}`,
            `https://live.bilibili.com/${status.roomId}`,
        ].join('\n');

        this.notificationService.enqueue(`live:${streamer.uid}:start:${status.liveTime}`, streamer.uid, {
            text: message,
            image: streamer.cover,
        }, true);
    }

    /** 发送下播通知 */
    private enqueueLiveEndNotification(streamer: Streamer, startTime: number): void {
        const duration = this.formatDuration(startTime);
        const message = `【下播提醒】\n${streamer.uname}下播了\n本次直播时长: ${duration}`;

        // 下播通知不@全体
        this.notificationService.enqueue(`live:${streamer.uid}:end:${startTime}`, streamer.uid, { text: message }, false);
    }

    /** 格式化直播时长 */
    private formatDuration(startTime: number): string {
        if (!startTime) return '未知';

        const seconds = Math.floor(Date.now() / 1000) - startTime;
        if (seconds <= 0) return '未知';

        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;

        if (h > 0) return `${h}小时${m}分钟${s}秒`;
        if (m > 0) return `${m}分钟${s}秒`;
        return `${s}秒`;
    }

    /** 加载缓存 */
    private loadCache(): void {
        const cache = pluginState.loadDataFile<Record<string, StreamerLiveCache>>('live_cache.json', {});
        for (const [uid, data] of Object.entries(cache)) {
            this.liveCache.set(Number(uid), data);
        }
    }

    /** 保存缓存 */
    private saveCache(): void {
        const data: Record<string, StreamerLiveCache> = {};
        for (const [uid, cache] of this.liveCache) {
            data[uid] = cache;
        }
        pluginState.saveDataFile('live_cache.json', data);
    }

    getStatus(): boolean {
        return this.isRunning;
    }
}

// 单例
let instance: LiveMonitorService | null = null;

export function startLiveMonitor(ctx: NapCatPluginContext): LiveMonitorService {
    if (!instance) {
        instance = new LiveMonitorService(ctx);
    }
    instance.start();
    return instance;
}

export async function stopLiveMonitor(): Promise<void> {
    const current = instance;
    try {
        await current?.stop();
    } finally {
        if (instance === current) instance = null;
    }
}

export function getLiveMonitor(): LiveMonitorService | null {
    return instance;
}
