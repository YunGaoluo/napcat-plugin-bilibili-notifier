/**
 * 动态监控服务
 * 负责定时检查主播动态更新并发送通知
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { pluginState } from '../core/state';
import { storage } from '../core/storage';
import { getUserDynamics } from './bilibili-service';
import { DynamicInfo, DynamicType } from '../types';
import { createNotificationService, type NotificationService } from './notification-service';

/** 动态缓存 */
interface DynamicCache {
    /** 上次检查时间戳（毫秒） */
    lastCheckTime: number;
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
};

/** 需要跳过的动态类型（不推送） */
const SKIP_DYNAMIC_TYPES: DynamicType[] = [
    DynamicType.LIVE,  // 直播开播动态不推送
];

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
                // 添加短暂延迟避免请求过快
                await this.delay(1000);
            }

            this.saveCache();
        } catch (error) {
            this.ctx.logger.error('检查动态更新失败:', error);
        }
    }

    /** 检查单个主播的最新动态 */
    private async checkStreamerDynamic(uid: number): Promise<void> {
        const streamer = storage.getStreamer(uid);
        if (!streamer) return;

        // 获取用户动态列表
        const dynamics = await getUserDynamics(uid);
        if (dynamics.length === 0) return;

        const now = Date.now();
        const cache = this.dynamicCache.get(uid);

        // 首次检查，只记录不推送
        if (!cache) {
            this.dynamicCache.set(uid, {
                lastCheckTime: now,
            });
            this.ctx.logger.debug(`[动态] 初始化 ${streamer.uname} 的动态缓存`);
            return;
        }

        // 根据发布时间找出所有新动态
        const newDynamics = this.findNewDynamicsByTime(dynamics, cache.lastCheckTime);

        // 过滤掉不需要推送的类型（如直播）
        const filteredDynamics = newDynamics.filter(dynamic => !SKIP_DYNAMIC_TYPES.includes(dynamic.type));

        if (filteredDynamics.length > 0) {
            // 按时间正序推送（先发旧的，再发新的）
            for (let i = filteredDynamics.length - 1; i >= 0; i--) {
                const dynamic = filteredDynamics[i];
                this.ctx.logger.info(`[新动态] ${streamer.uname}: ${DYNAMIC_TYPE_NAMES[dynamic.type] || '未知类型'}`);
                await this.sendDynamicNotification(uid, dynamic);
            }
        }

        // 记录被跳过的动态
        const skippedCount = newDynamics.length - filteredDynamics.length;
        if (skippedCount > 0) {
            this.ctx.logger.debug(`[动态] ${streamer.uname}: 跳过 ${skippedCount} 条直播动态`);
        }

        // 更新缓存
        cache.lastCheckTime = now;
        this.dynamicCache.set(uid, cache);
    }

    /**
     * 根据发布时间找出所有新动态
     * @param dynamics 动态列表
     * @param lastCheckTime 上次检查时间（毫秒）
     * @returns 发布时间在上次检查时间之后的动态
     */
    private findNewDynamicsByTime(dynamics: DynamicInfo[], lastCheckTime: number): DynamicInfo[] {
        // pub_ts 是秒级时间戳，需要转换为毫秒进行比较
        return dynamics.filter(dynamic => dynamic.author.pub_ts * 1000 > lastCheckTime);
    }

    /** 发送动态通知 */
    private async sendDynamicNotification(uid: number, dynamic: DynamicInfo): Promise<void> {
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

        await this.notificationService.sendToSubscribers(uid, {
            text: message,
            image,
        });
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

    /** 延迟函数 */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
