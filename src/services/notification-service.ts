/**
 * 消息通知服务
 * 统一处理群和用户的通知发送
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import { OB11MessageDataType } from 'napcat-types/napcat-onebot/types/message';
import { storage } from '../core/storage';
import { pluginState } from '../core/state';

export interface NotificationMessage {
    text: string;
    image?: string;
}

interface PendingNotification {
    uid: number;
    message: NotificationMessage;
    atAll: boolean;
    targets: string[];
}

export class NotificationService {
    private ctx: NapCatPluginContext;
    private pending: Map<string, PendingNotification>;
    private flushing: Promise<void> | null = null;

    constructor(ctx: NapCatPluginContext) {
        this.ctx = ctx;
        this.pending = new Map(Object.entries(
            pluginState.loadDataFile<Record<string, PendingNotification>>('notification_queue.json', {})
        ));
    }

    /**
     * 先持久化事件与目标，再推进监控缓存。重复事件不会覆盖已送达记录。
     * 传入 targets 时只投递给指定目标，用于订阅后的单目标补发。
     */
    enqueue(id: string, uid: number, message: NotificationMessage, atAll: boolean, targets?: string[]): void {
        if (this.pending.has(id) || !pluginState.config.enabled) return;
        const resolved = targets ? [...targets] : [
            ...storage.getStreamerEnabledGroups(uid).map(group => `group:${group.groupId}`),
            ...storage.getStreamerSubscribedUsers(uid).map(user => `private:${user.userId}`),
        ];
        if (resolved.length === 0) return;
        this.pending.set(id, { uid, message, atAll, targets: resolved });
        try {
            this.save();
        } catch (error) {
            this.pending.delete(id);
            throw error;
        }
    }

    /** 两种监控共享一个发送任务，失败目标留到下一轮，成功目标立即落盘。 */
    flush(signal?: AbortSignal): Promise<void> {
        if (this.flushing) return this.flushing;
        this.flushing = this.sendPending(signal).finally(() => { this.flushing = null; });
        return this.flushing;
    }

    private async sendPending(signal?: AbortSignal): Promise<void> {
        const blockedTargets = new Set<string>();
        for (const [id, entry] of this.pending) {
            for (const target of [...entry.targets]) {
                if (signal?.aborted || !pluginState.config.enabled) return;
                if (blockedTargets.has(target)) continue;
                const separator = target.indexOf(':');
                const kind = target.slice(0, separator);
                const targetId = target.slice(separator + 1);
                const group = kind === 'group' ? storage.getGroupSub(targetId) : undefined;
                const subscribed = kind === 'group'
                    ? group?.streamerUids.includes(entry.uid)
                    : storage.getUserSub(targetId)?.streamerUids.includes(entry.uid);
                if (!subscribed) {
                    this.acknowledge(id, entry, target);
                    continue;
                }
                if (group && (!group.enabled || !pluginState.isGroupEnabled(targetId))) continue;
                const segments = this.buildMessageSegments(entry.message, !!group && entry.atAll && group.enableAtAll);
                try {
                    if (kind === 'group') await this.sendToGroup(targetId, segments);
                    else await this.sendToUser(targetId, segments);
                } catch (error) {
                    blockedTargets.add(target);
                    this.ctx.logger.error(`发送通知到 ${target} 失败，保留待重试:`, error);
                    continue;
                }
                this.acknowledge(id, entry, target);
                if (pluginState.config.debug) this.ctx.logger.debug(`通知已发送到 ${target}`);
            }
        }
    }

    private acknowledge(id: string, entry: PendingNotification, target: string): void {
        const previous = entry.targets;
        entry.targets = previous.filter(value => value !== target);
        if (entry.targets.length === 0) this.pending.delete(id);
        try {
            this.save();
        } catch (error) {
            entry.targets = previous;
            this.pending.set(id, entry);
            throw error;
        }
    }

    private save(): void {
        pluginState.saveDataFile('notification_queue.json', Object.fromEntries(this.pending));
    }

    /**
     * 构建消息段
     * @param message 消息内容
     * @param atAll 是否@全体
     */
    private buildMessageSegments(message: NotificationMessage, atAll: boolean): OB11PostSendMsg['message'] {
        const segments: OB11PostSendMsg['message'] = [];

        // 如果开启@全体，添加@全体消息段
        if (atAll) {
            segments.push({ type: OB11MessageDataType.at, data: { qq: 'all' } });
            segments.push({ type: OB11MessageDataType.text, data: { text: '\n' } });
        }

        // 添加文本消息
        segments.push({ type: OB11MessageDataType.text, data: { text: message.text } });

        // 添加图片（如果有）；卡片以 base64 传入，远程图片才附带 url
        if (message.image) {
            segments.push(message.image.startsWith('base64://')
                ? { type: OB11MessageDataType.image, data: { file: message.image } }
                : { type: OB11MessageDataType.image, data: { file: message.image, url: message.image } });
        }

        return segments;
    }

    /**
     * 发送消息到群
     */
    private async sendToGroup(groupId: string, message: OB11PostSendMsg['message']): Promise<void> {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'group',
            group_id: groupId,
        };
        await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config);
    }

    /**
     * 发送消息给用户
     */
    private async sendToUser(userId: string, message: OB11PostSendMsg['message']): Promise<void> {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'private',
            user_id: userId,
        };
        await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config);
    }
}

let instance: NotificationService | null = null;
let instanceContext: NapCatPluginContext | null = null;

export function createNotificationService(ctx: NapCatPluginContext): NotificationService {
    if (!instance || instanceContext !== ctx) {
        instance = new NotificationService(ctx);
        instanceContext = ctx;
    }
    return instance;
}

export function clearNotificationService(): void {
    instance = null;
    instanceContext = null;
}
