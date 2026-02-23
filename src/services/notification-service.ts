/**
 * 消息通知服务
 * 统一处理群和用户的通知发送
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
// @ts-ignore
import type { OB11PostSendMsg } from 'napcat-types/napcat-onebot/types/event';
import { storage } from '../core/storage';

export interface NotificationMessage {
    text: string;
    image?: string;
}

export class NotificationService {
    private ctx: NapCatPluginContext;

    constructor(ctx: NapCatPluginContext) {
        this.ctx = ctx;
    }

    /**
     * 发送通知给订阅了主播的所有群和用户
     */
    async sendToSubscribers(uid: number, message: NotificationMessage): Promise<void> {
        const groups = storage.getStreamerEnabledGroups(uid);
        const users = storage.getStreamerSubscribedUsers(uid);

        if (groups.length === 0 && users.length === 0) {
            return;
        }

        // 构建消息段
        const messageSegments: OB11PostSendMsg['message'] = [
            { type: 'text', data: { text: message.text } },
        ];

        if (message.image) {
            messageSegments.push({
                type: 'image',
                data: { file: message.image, url: message.image },
            });
        }

        // 发送到群
        for (const group of groups) {
            try {
                await this.sendToGroup(group.groupId, messageSegments);
                this.ctx.logger.debug(`通知已发送到群 ${group.groupId}`);
            } catch (error) {
                this.ctx.logger.error(`发送通知到群 ${group.groupId} 失败:`, error);
            }
        }

        // 发送到用户
        for (const user of users) {
            try {
                await this.sendToUser(user.userId, messageSegments);
                this.ctx.logger.debug(`通知已发送给用户 ${user.userId}`);
            } catch (error) {
                this.ctx.logger.error(`发送通知给用户 ${user.userId} 失败:`, error);
            }
        }
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

// 单例实例
let instance: NotificationService | null = null;

export function createNotificationService(ctx: NapCatPluginContext): NotificationService {
    instance = new NotificationService(ctx);
    return instance;
}

export function getNotificationService(): NotificationService | null {
    return instance;
}
