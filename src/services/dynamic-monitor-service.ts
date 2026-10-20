/**
 * 动态监控服务
 * 负责定时检查主播动态更新并发送通知
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginState } from '../core/state';
import { storage } from '../core/storage';
import { getUserDynamics } from './bilibili-service';
import { DynamicInfo, DynamicType } from '../types';
import { createNotificationService, type NotificationService } from './notification-service';

/** 动态缓存 */
interface DynamicCache {
    /** 已处理的动态 ID，不依赖发布时间与本机时钟。 */
    seenIds: string[];
}

/** 动态类型显示映射 */
const DYNAMIC_TYPE_NAMES: Record<DynamicType, string> = {
    DYNAMIC_TYPE_FORWARD: '转发',
    DYNAMIC_TYPE_AV: '视频',
    DYNAMIC_TYPE_DRAW: '图文',
    DYNAMIC_TYPE_WORD: '文字',
    DYNAMIC_TYPE_ARTICLE: '专栏',
    DYNAMIC_TYPE_MUSIC: '音频',
    DYNAMIC_TYPE_LIVE: '直播',
    DYNAMIC_TYPE_LIVE_RCMD: '直播推荐',
};

/** 需要跳过的动态类型（不推送） */
const SKIP_DYNAMIC_TYPES: DynamicType[] = [
    DynamicType.LIVE,       // 直播开播动态不推送（已有直播监控处理）
    DynamicType.LIVE_RCMD,  // 直播推荐动态不推送（动态流中的直播卡片）
];

export class DynamicMonitorService {
    private ctx: NapCatPluginContext;
    private notificationService: NotificationService;
    private cronJob: ScheduledTask | null = null;
    private isRunning: boolean = false;
    private dynamicCache: Map<number, DynamicCache> = new Map();
    private inFlight: Promise<void> | null = null;
    private controller: AbortController | null = null;

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
        void this.checkAllStreamers();

        // 每分钟检查一次（动态更新频率不需要太高）
        this.cronJob = cron.schedule('0 * * * * *', () => {
            void this.checkAllStreamers();
        });
    }

    /** 停止动态监控 */
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
            if (!controller.signal.aborted) this.ctx.logger.error('检查动态更新失败:', error);
        }).finally(() => {
            this.inFlight = null;
            this.controller = null;
        });
        return this.inFlight;
    }

    private async runCheck(signal: AbortSignal): Promise<void> {
        await this.notificationService.flush(signal);
        const streamers = storage.getAllStreamers().filter(streamer =>
            storage.getStreamerEnabledGroups(streamer.uid).length > 0
            || storage.getStreamerSubscribedUsers(streamer.uid).length > 0
        );
        for (let i = 0; i < streamers.length; i++) {
            if (signal.aborted || !pluginState.config.enabled) return;
            try {
                await this.checkStreamerDynamic(streamers[i].uid, signal);
            } catch (error) {
                if (signal.aborted) return;
                this.ctx.logger.error(`检查用户 ${streamers[i].uid} 动态失败:`, error);
            }
            if (i + 1 < streamers.length) await delay(1000, undefined, { signal });
        }
        await this.notificationService.flush(signal);
    }

    /** 检查单个主播的最新动态 */
    private async checkStreamerDynamic(uid: number, signal?: AbortSignal): Promise<void> {
        if (!pluginState.config.enabled || signal?.aborted) return;
        const streamer = storage.getStreamer(uid);
        if (!streamer) return;
        const cache = this.dynamicCache.get(uid);
        const seen = cache ? new Set(cache.seenIds) : undefined;
        const dynamics = await getUserDynamics(uid, seen, signal);
        if (signal?.aborted || !pluginState.config.enabled) return;
        if (!seen) {
            this.dynamicCache.set(uid, { seenIds: dynamics.map(dynamic => dynamic.id) });
            this.saveCache();
            if (pluginState.config.debug) this.ctx.logger.debug(`[动态] 初始化 ${streamer.uname} 的动态缓存`);
            return;
        }
        dynamics.sort((a, b) => a.author.pub_ts - b.author.pub_ts);
        for (const dynamic of dynamics) {
            if (seen.has(dynamic.id)) continue;
            if (!SKIP_DYNAMIC_TYPES.includes(dynamic.type)) {
                this.enqueueDynamicNotification(uid, dynamic);
                this.ctx.logger.info(`[新动态] ${streamer.uname}: ${DYNAMIC_TYPE_NAMES[dynamic.type] || '未知类型'}`);
            }
            seen.add(dynamic.id);
        }
        this.dynamicCache.set(uid, { seenIds: [...seen] });
        this.saveCache();
    }

    /** 发送动态通知 */
    private enqueueDynamicNotification(uid: number, dynamic: DynamicInfo): void {
        const streamer = storage.getStreamer(uid);
        if (!streamer) return;

        const typeName = DYNAMIC_TYPE_NAMES[dynamic.type] || '动态';
        const message = this.buildDynamicMessage(streamer.uname, typeName, dynamic);

        // 获取第一张图片（如果有）
        let image: string | undefined;
        if (dynamic.archive?.cover) {
            image = dynamic.archive.cover;
        } else if (dynamic.draw?.items && dynamic.draw.items.length > 0) {
            image = dynamic.draw.items[0].src;
        }

        this.notificationService.enqueue(`dynamic:${uid}:${dynamic.id}`, uid, {
            text: message,
            image,
        }, false);
    }

    /** 构建动态消息文本 */
    private buildDynamicMessage(uname: string, typeName: string, dynamic: DynamicInfo): string {
        const lines: string[] = [];

        // 标题行
        lines.push(`${uname} 发布了新${typeName}动态！`);
        lines.push('');

        // 内容（限制长度）
        const content = dynamic.content.text || '无文字内容';
        lines.push(this.truncateText(content, 200));

        // 视频/专栏链接
        if (dynamic.archive) {
            lines.push('');
            lines.push(`《${dynamic.archive.title}》`);
            lines.push(`https://www.bilibili.com/video/${dynamic.archive.bvid}`);
        }

        // 转发源
        if (dynamic.orig) {
            lines.push('');
            lines.push('━━━━━━━━━━━━');
            lines.push(`转发自 @${dynamic.orig.author.name}:`);
            const origContent = dynamic.orig.content.text || '无文字内容';
            lines.push(this.truncateText(origContent, 100));
            if (dynamic.orig.archive) {
                lines.push(`https://www.bilibili.com/video/${dynamic.orig.archive.bvid}`);
            }
        }

        // 动态链接
        lines.push('');
        lines.push(`https://t.bilibili.com/${dynamic.id}`);

        return lines.join('\n');
    }

    /** 截断文本 */
    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }


    /** 加载缓存 */
    private loadCache(): void {
        const cache = pluginState.loadDataFile<Record<string, DynamicCache>>('dynamic_cache.json', {});
        for (const [uid, data] of Object.entries(cache)) {
            if (data && Array.isArray(data.seenIds) && data.seenIds.every(id => typeof id === 'string')) {
                this.dynamicCache.set(Number(uid), data);
            }
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

export async function stopDynamicMonitor(): Promise<void> {
    const current = instance;
    try {
        await current?.stop();
    } finally {
        if (instance === current) instance = null;
    }
}

export function getDynamicMonitor(): DynamicMonitorService | null {
    return instance;
}
