/**
 * 直播监控服务
 * 负责定时检查主播直播状态并发送开播/下播通知
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
// @ts-ignore
import type { OB11PostSendMsg } from 'napcat-types/napcat-onebot/types/event';
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { pluginState } from '../core/state';
import { storage } from '../core/storage';
import type { Streamer } from '../core/storage';
import { getLiveRoomStatusBatch } from './bilibili-service';
import type { LiveRoomStatus } from '../types';

/** 主播直播状态缓存 - 用于检测状态变化 */
interface StreamerLiveCache {
    /** 上次直播状态: 0=未开播, 1=直播中, 2=轮播中 */
    lastLiveStatus: number;
    /** 上次开播时间戳 */
    lastLiveTime: number;
    /** 上次检查时间 */
    lastCheckTime: number;
}

export class LiveMonitorService {
    private ctx: NapCatPluginContext;
    private cronJob: ScheduledTask | null = null;
    private isRunning: boolean = false;
    /** 主播状态缓存 Map<uid, StreamerLiveCache> */
    private liveCache: Map<number, StreamerLiveCache> = new Map();

    constructor(ctx: NapCatPluginContext) {
        this.ctx = ctx;
        this.loadCache();
    }

    /**
     * 加载缓存的直播状态
     */
    private loadCache(): void {
        const cache = pluginState.loadDataFile<Record<string, StreamerLiveCache>>('live_cache.json', {});
        for (const [uid, data] of Object.entries(cache)) {
            this.liveCache.set(Number(uid), data);
        }
    }

    /**
     * 保存直播状态缓存
     */
    private saveCache(): void {
        const data: Record<string, StreamerLiveCache> = {};
        for (const [uid, cache] of this.liveCache) {
            data[uid] = cache;
        }
        pluginState.saveDataFile('live_cache.json', data);
    }

    /**
     * 启动直播监控
     */
    start(): void {
        if (this.isRunning) {
            this.ctx.logger.warn('直播监控已在运行中');
            return;
        }

        this.ctx.logger.info('启动直播监控服务');
        this.isRunning = true;

        // 立即执行一次检查
        this.checkAllStreamers();

        // 每10秒检查一次 (cron表达式: 每10秒执行)
        this.cronJob = cron.schedule('*/10 * * * * *', () => {
            this.checkAllStreamers();
        }, {
            scheduled: true
        });
    }

    /**
     * 停止直播监控
     */
    stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.ctx.logger.info('停止直播监控服务');

        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }

        this.saveCache();
        this.isRunning = false;
    }

    /**
     * 检查所有订阅的主播
     */
    private async checkAllStreamers(): Promise<void> {
        try {
            // 获取所有有订阅的主播
            const allStreamers = storage.getAllStreamers();
            const subscribedStreamers = allStreamers.filter(s => storage.hasAnySubscribers(s.uid));

            if (subscribedStreamers.length === 0) {
                return;
            }

            // 获取所有订阅主播的UID
            const uids = subscribedStreamers.map(s => s.uid);

            // 批量查询直播状态
            const statusMap = await getLiveRoomStatusBatch(uids);

            // 处理每个主播的状态
            for (const streamer of subscribedStreamers) {
                const newStatus = statusMap.get(streamer.uid);
                if (newStatus) {
                    await this.processStreamerStatus(streamer, newStatus);
                }
            }

            // 保存状态缓存
            this.saveCache();
        } catch (error) {
            this.ctx.logger.error('检查主播状态失败:', error);
        }
    }

    /**
     * 处理单个主播的状态变化
     */
    private async processStreamerStatus(streamer: Streamer, newStatus: LiveRoomStatus): Promise<void> {
        const cache = this.liveCache.get(streamer.uid) ?? {
            lastLiveStatus: 0,
            lastLiveTime: 0,
            lastCheckTime: 0,
        };

        const oldStatus = cache.lastLiveStatus;
        const currentStatus = newStatus.liveStatus;

        // 更新主播信息
        streamer.liveStatus = currentStatus;
        streamer.liveTime = newStatus.liveTime;
        streamer.title = newStatus.title;
        streamer.cover = newStatus.cover;
        streamer.face = newStatus.face;
        streamer.uname = newStatus.uname;
        storage.setStreamer(streamer);

        // 检测状态变化
        // 0=未开播, 1=直播中, 2=轮播中
        const wasLive = oldStatus === 1;
        const isLive = currentStatus === 1;

        // 开播检测：从非直播状态变为直播中
        if (!wasLive && isLive) {
            this.ctx.logger.info(`[开播] ${streamer.uname} (UID: ${streamer.uid})`);
            await this.sendLiveStartNotification(streamer, newStatus);
            cache.lastLiveTime = newStatus.liveTime;
        }
        // 下播检测：从直播中变为非直播状态
        else if (wasLive && !isLive) {
            this.ctx.logger.info(`[下播] ${streamer.uname} (UID: ${streamer.uid})`);
            const duration = this.calculateDuration(cache.lastLiveTime);
            await this.sendLiveEndNotification(streamer, duration);
        }

        // 更新缓存
        cache.lastLiveStatus = currentStatus;
        cache.lastCheckTime = Date.now();
        this.liveCache.set(streamer.uid, cache);
    }

    /**
     * 发送开播通知
     */
    private async sendLiveStartNotification(streamer: Streamer, status: LiveRoomStatus): Promise<void> {
        const groups = storage.getStreamerEnabledGroups(streamer.uid);
        const users = storage.getStreamerSubscribedUsers(streamer.uid);

        // 构建开播消息
        const message = [
            `${streamer.uname} 开播啦！`,
            `标题：${status.title}`,
            `分区: ${status.parentAreaName} - ${status.areaName}`,
            `https://live.bilibili.com/${status.roomId}`,
        ].join('\n');

        // 构建消息段
        const messageSegments: OB11PostSendMsg['message'] = [
            { type: 'text', data: { text: message } },
        ];

        // 添加封面图
        if (streamer.cover) {
            messageSegments.push({
                type: 'image',
                data: { file: streamer.cover, url: streamer.cover },
            });
        }

        // 发送到所有订阅的群
        for (const group of groups) {
            try {
                const params: OB11PostSendMsg = {
                    message: messageSegments,
                    message_type: 'group',
                    group_id: group.groupId,
                };
                await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config);
                this.ctx.logger.debug(`开播通知已发送到群 ${group.groupId}`);
            } catch (error) {
                this.ctx.logger.error(`发送开播通知到群 ${group.groupId} 失败:`, error);
            }
        }

        // 发送到所有订阅的用户
        for (const user of users) {
            try {
                const params: OB11PostSendMsg = {
                    message: messageSegments,
                    message_type: 'private',
                    user_id: user.userId,
                };
                await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config);
                this.ctx.logger.debug(`开播通知已发送给用户 ${user.userId}`);
            } catch (error) {
                this.ctx.logger.error(`发送开播通知给用户 ${user.userId} 失败:`, error);
            }
        }
    }

    /**
     * 发送下播通知
     */
    private async sendLiveEndNotification(streamer: Streamer, duration: string): Promise<void> {
        const groups = storage.getStreamerEnabledGroups(streamer.uid);
        const users = storage.getStreamerSubscribedUsers(streamer.uid);

        // 构建下播消息
        const message = [
            `${streamer.uname}下播了`,
            `本次直播时长: ${duration}`,
        ].join('\n');

        // 构建消息段
        const messageSegments: OB11PostSendMsg['message'] = [
            { type: 'text', data: { text: message } },
        ];

        // 发送到所有订阅的群
        for (const group of groups) {
            try {
                const params: OB11PostSendMsg = {
                    message: messageSegments,
                    message_type: 'group',
                    group_id: group.groupId,
                };
                await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config);
                this.ctx.logger.debug(`下播通知已发送到群 ${group.groupId}`);
            } catch (error) {
                this.ctx.logger.error(`发送下播通知到群 ${group.groupId} 失败:`, error);
            }
        }

        // 发送到所有订阅的用户
        for (const user of users) {
            try {
                const params: OB11PostSendMsg = {
                    message: messageSegments,
                    message_type: 'private',
                    user_id: user.userId,
                };
                await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config);
                this.ctx.logger.debug(`下播通知已发送给用户 ${user.userId}`);
            } catch (error) {
                this.ctx.logger.error(`发送下播通知给用户 ${user.userId} 失败:`, error);
            }
        }
    }

    /**
     * 计算直播时长
     */
    private calculateDuration(startTime: number): string {
        if (!startTime || startTime <= 0) {
            return '未知';
        }

        const now = Math.floor(Date.now() / 1000);
        const duration = now - startTime;

        if (duration < 0) {
            return '未知';
        }

        const hours = Math.floor(duration / 3600);
        const minutes = Math.floor((duration % 3600) / 60);
        const seconds = duration % 60;

        if (hours > 0) {
            return `${hours}小时${minutes}分钟${seconds}秒`;
        } else if (minutes > 0) {
            return `${minutes}分钟${seconds}秒`;
        } else {
            return `${seconds}秒`;
        }
    }

    /**
     * 获取运行状态
     */
    getStatus(): boolean {
        return this.isRunning;
    }
}

// 单例实例
let monitorInstance: LiveMonitorService | null = null;

/**
 * 初始化并启动直播监控服务
 */
export function startLiveMonitor(ctx: NapCatPluginContext): LiveMonitorService {
    if (!monitorInstance) {
        monitorInstance = new LiveMonitorService(ctx);
    }
    monitorInstance.start();
    return monitorInstance;
}

/**
 * 停止直播监控服务
 */
export function stopLiveMonitor(): void {
    if (monitorInstance) {
        monitorInstance.stop();
        monitorInstance = null;
    }
}

/**
 * 获取直播监控服务实例
 */
export function getLiveMonitor(): LiveMonitorService | null {
    return monitorInstance;
}
