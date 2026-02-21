/**
 * 消息处理器
 *
 * 处理接收到的 QQ 消息事件，包含：
 * - 命令解析与分发
 * - 消息发送工具函数
 *
 * 最佳实践：将不同类型的业务逻辑拆分到不同的 handler 文件中，
 * 保持每个文件职责单一。
 */

import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import {getLiveRoomStatusBatch} from "../services/bilibili-service";
import {storage, Streamer} from "../core/storage";

// ==================== 命令解析 ====================

const COMMAND_PREFIX = '#blive';

interface ParsedCommand {
    subCommand: string;
    args: string[];
}

function parseCommand(message: string): ParsedCommand | null {
    if (!message.startsWith(COMMAND_PREFIX)) return null;

    const parts = message.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    const subCommand = parts[0]?.toLowerCase() || '';
    const args = parts.slice(1);

    return { subCommand, args };
}

// ==================== 消息发送工具 ====================

/**
 * 发送消息（通用）
 * 根据消息类型自动发送到群或私聊
 *
 * @param ctx 插件上下文
 * @param event 原始消息事件（用于推断回复目标）
 * @param message 消息内容（支持字符串或消息段数组）
 */
export async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: event.message_type,
            ...(event.message_type === 'group' && event.group_id
                ? { group_id: String(event.group_id) }
                : {}),
            ...(event.message_type === 'private' && event.user_id
                ? { user_id: String(event.user_id) }
                : {}),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送消息失败:', error);
        return false;
    }
}

/**
 * 发送群消息
 */
export async function sendGroupMessage(
    ctx: NapCatPluginContext,
    groupId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'group',
            group_id: String(groupId),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送群消息失败:', error);
        return false;
    }
}

/**
 * 发送私聊消息
 */
export async function sendPrivateMessage(
    ctx: NapCatPluginContext,
    userId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'private',
            user_id: String(userId),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送私聊消息失败:', error);
        return false;
    }
}

// ==================== 合并转发消息 ====================

/** 合并转发消息节点 */
export interface ForwardNode {
    type: 'node';
    data: {
        nickname: string;
        user_id?: string;
        content: Array<{ type: string; data: Record<string, unknown> }>;
    };
}

/**
 * 发送合并转发消息
 * @param ctx 插件上下文
 * @param target 群号或用户 ID
 * @param isGroup 是否为群消息
 * @param nodes 合并转发节点列表
 */
export async function sendForwardMsg(
    ctx: NapCatPluginContext,
    target: number | string,
    isGroup: boolean,
    nodes: ForwardNode[],
): Promise<boolean> {
    try {
        const actionName = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
        const params: Record<string, unknown> = { message: nodes };
        if (isGroup) {
            params.group_id = String(target);
        } else {
            params.user_id = String(target);
        }
        await ctx.actions.call(
            actionName as 'send_group_forward_msg',
            params as never,
            ctx.adapterName,
            ctx.pluginManager.config,
        );
        return true;
    } catch (error) {
        pluginState.logger.error('发送合并转发消息失败:', error);
        return false;
    }
}

// ==================== 权限检查 ====================

/**
 * 检查群聊中是否有管理员权限
 * 私聊消息默认返回 true
 */
export function isAdmin(event: OB11Message): boolean {
    if (event.message_type !== 'group') return true;
    const role = (event.sender as Record<string, unknown>)?.role;
    return role === 'admin' || role === 'owner';
}

// ==================== 消息处理主函数 ====================

/**
 * 消息处理主函数
 * 在这里实现你的命令处理逻辑
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        const rawMessage = event.raw_message || '';
        const messageType = event.message_type;
        const groupId = event.group_id;
        const userId = event.user_id;

        pluginState.ctx.logger.debug(`收到消息: ${rawMessage} | 类型: ${messageType}`);

        // 群消息：检查该群是否启用
        if (messageType === 'group' && groupId) {
            if (!pluginState.isGroupEnabled(String(groupId))) return;
        }

        const parsed = parseCommand(rawMessage);
        if (!parsed) return;

        const { subCommand, args } = parsed;

        // TODO: 在这里实现你的命令处理逻辑
        switch (subCommand) {
            case 'help': {
                const helpText = [
                    `[= B站直播订阅插件帮助 =]`,
                    `${COMMAND_PREFIX} help - 显示帮助信息`,
                    `${COMMAND_PREFIX} ping - 测试连通性`,
                    `${COMMAND_PREFIX} status - 查看运行状态`,
                    ``,
                    `【订阅管理】`,
                    `${COMMAND_PREFIX} sub <UID> - 订阅主播(群/私聊)`,
                    `${COMMAND_PREFIX} unsub <UID> - 取消订阅主播`,
                    `${COMMAND_PREFIX} list - 查看订阅列表`,
                    ``,
                    `【群管理】`,
                    `${COMMAND_PREFIX} atall on/off - 开启/关闭@全体`,
                ].join('\n');
                await sendReply(ctx, event, helpText);
                break;
            }

            case 'ping': {
                await sendReply(ctx, event, 'pong!');
                pluginState.incrementProcessed();
                break;
            }

            case 'status': {
                const statusText = [
                    `[= 插件状态 =]`,
                    `运行时长: ${pluginState.getUptimeFormatted()}`,
                    `今日处理: ${pluginState.stats.todayProcessed}`,
                    `总计处理: ${pluginState.stats.processed}`,
                ].join('\n');
                await sendReply(ctx, event, statusText);
                break;
            }

            case '订阅':
            case 'add':
            case '关注': {
                await handleSubscribe(ctx, event, args);
                pluginState.incrementProcessed();
                break;
            }

            case 'list':
            case '列表': {
                await handleList(ctx, event, args);
                pluginState.incrementProcessed();
                break;
            }

            case 'remove':
            case '取消订阅': {
                await handleUnsubscribe(ctx, event, args);
                pluginState.incrementProcessed();
                break;
            }

            case 'atall':
            case '全体': {
                await handleAtAll(ctx, event, args);
                pluginState.incrementProcessed();
                break;
            }

            default: {
                break;
            }
        }
    } catch (error) {
        pluginState.logger.error('处理消息时出错:', error);
    }
}


// ==================== 业务逻辑 ====================

/**
 * 处理订阅命令
 * 支持群订阅和用户私聊订阅
 */
async function handleSubscribe(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
): Promise<void> {
    if (args.length === 0) {
        await sendReply(ctx, event, `用法: ${COMMAND_PREFIX} sub <UID>\n例如: ${COMMAND_PREFIX} sub 123456`);
        return;
    }

    const uid = parseInt(args[0], 10);
    if (isNaN(uid) || uid <= 0) {
        await sendReply(ctx, event, '请输入有效的UID');
        return;
    }

    // 检查主播是否已在数据库中
    let streamer = storage.getStreamer(uid);

    // 如果不在，尝试从B站获取信息
    if (!streamer) {
        const liveRoomData = await getLiveRoomStatusBatch([uid]);
        if (liveRoomData.size === 0) {
            await sendReply(ctx, event, `未找到UID为 ${uid} 的主播信息`);
            return;
        }
        const roomStatus = Array.from(liveRoomData.values())[0];
        streamer = {
            uid: roomStatus.uid,
            roomId: roomStatus.roomId,
            uname: roomStatus.uname,
            liveStatus: roomStatus.liveStatus,
            liveTime: roomStatus.liveTime,
            title: roomStatus.title,
            face: roomStatus.face,
            cover: roomStatus.cover,
        };
        storage.setStreamer(streamer);
    }

    // 根据消息类型进行订阅
    if (event.message_type === 'group' && event.group_id) {
        // 群订阅
        const groupId = String(event.group_id);

        // 检查权限：只有管理员可以订阅
        if (!isAdmin(event)) {
            await sendReply(ctx, event, '只有群主或管理员才能订阅主播');
            return;
        }

        const success = storage.subscribeGroup(groupId, uid);
        if (success) {
            await sendReply(ctx, event, `群订阅成功\n主播: ${streamer.uname}\nUID: ${uid}\n直播间: https://live.bilibili.com/${streamer.roomId}`);
        } else {
            await sendReply(ctx, event, `本群已经订阅了 ${streamer.uname}`);
        }
    } else if (event.message_type === 'private' && event.user_id) {
        // 用户私聊订阅
        const userId = String(event.user_id);
        const success = storage.subscribeUser(userId, uid);
        if (success) {
            await sendReply(ctx, event, `订阅成功\n主播: ${streamer.uname}\nUID: ${uid}\n直播间: https://live.bilibili.com/${streamer.roomId}`);
        } else {
            await sendReply(ctx, event, `您已经订阅了 ${streamer.uname}`);
        }
    }
}

/**
 * 处理取消订阅命令
 */
async function handleUnsubscribe(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
): Promise<void> {
    if (args.length === 0) {
        await sendReply(ctx, event, `用法: ${COMMAND_PREFIX} unsub <UID>\n例如: ${COMMAND_PREFIX} unsub 123456`);
        return;
    }

    const uid = parseInt(args[0], 10);
    if (isNaN(uid) || uid <= 0) {
        await sendReply(ctx, event, '请输入有效的UID');
        return;
    }

    // 检查主播是否存在
    const streamer = storage.getStreamer(uid);
    if (!streamer) {
        await sendReply(ctx, event, `未找到UID为 ${uid} 的主播`);
        return;
    }

    // 根据消息类型进行取消订阅
    if (event.message_type === 'group' && event.group_id) {
        // 群取消订阅
        const groupId = String(event.group_id);

        // 检查权限
        if (!isAdmin(event)) {
            await sendReply(ctx, event, '只有群主或管理员才能取消订阅');
            return;
        }

        const success = storage.unsubscribeGroup(groupId, uid);
        if (success) {
            await sendReply(ctx, event, `已取消订阅\n主播: ${streamer.uname}\nUID: ${uid}`);
        } else {
            await sendReply(ctx, event, `本群没有订阅 ${streamer.uname}`);
        }
    } else if (event.message_type === 'private' && event.user_id) {
        // 用户取消订阅
        const userId = String(event.user_id);
        const success = storage.unsubscribeUser(userId, uid);
        if (success) {
            await sendReply(ctx, event, `已取消订阅\n主播: ${streamer.uname}\nUID: ${uid}`);
        } else {
            await sendReply(ctx, event, `您没有订阅 ${streamer.uname}`);
        }
    }
}

/**
 * 处理查看订阅列表命令
 */
async function handleList(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
): Promise<void> {
    const showAll = args.includes('all') || args.includes('全部');

    if (event.message_type === 'group' && event.group_id) {
        // 群订阅列表
        const groupId = String(event.group_id);
        const streamers = storage.getGroupSubscribedStreamers(groupId);
        const groupSub = storage.getGroupSub(groupId);

        if (streamers.length === 0) {
            await sendReply(ctx, event, '本群还没有订阅任何主播\n使用 ' + COMMAND_PREFIX + ' 订阅 <UID> 来订阅');
            return;
        }

        const lines = [
            `[= 本群订阅列表 =]`,
            `共 ${streamers.length} 个主播`,
            ``,
        ];

        for (let i = 0; i < streamers.length; i++) {
            const s = streamers[i];
            const status = s.liveStatus === 1 ? '🔴 直播中' : s.liveStatus === 2 ? '⏺️ 轮播中' : '⚫ 未开播';
            lines.push(`${i + 1}. ${s.uname}`);
            lines.push(`   UID: ${s.uid} | ${status}`);
            if (s.liveStatus === 1 && s.liveTime > 0) {
                const liveDuration = Math.floor((Date.now() / 1000 - s.liveTime) / 60);
                lines.push(`   已开播: ${liveDuration} 分钟`);
            }
            lines.push(`   https://live.bilibili.com/${s.roomId}`);
            lines.push('');
        }

        // 添加群设置信息
        if (groupSub) {
            lines.push(`[群设置]`);
            lines.push(`@全体: ${groupSub.enableAtAll ? '开启' : '关闭'}`);
            lines.push(`推送: ${groupSub.enabled ? '开启' : '关闭'}`);
        }

        await sendReply(ctx, event, lines.join('\n'));

    } else if (event.message_type === 'private' && event.user_id) {
        // 用户个人订阅列表
        const userId = String(event.user_id);
        const streamers = storage.getUserSubscribedStreamers(userId);

        if (streamers.length === 0) {
            await sendReply(ctx, event, '您还没有订阅任何主播\n使用 ' + COMMAND_PREFIX + ' sub <UID> 来订阅');
            return;
        }

        const lines = [
            `[= 您的订阅列表 =]`,
            `共 ${streamers.length} 个主播`,
            ``,
        ];

        for (let i = 0; i < streamers.length; i++) {
            const s = streamers[i];
            const status = s.liveStatus === 1 ? '🔴 直播中' : s.liveStatus === 2 ? '⏺️ 轮播中' : '⚫ 未开播';
            lines.push(`${i + 1}. ${s.uname}`);
            lines.push(`   UID: ${s.uid} | ${status}`);
            if (s.title) {
                lines.push(`   标题: ${s.title}`);
            }
            lines.push(`   https://live.bilibili.com/${s.roomId}`);
            lines.push('');
        }

        await sendReply(ctx, event, lines.join('\n'));
    }
}

/**
 * 处理群@全体设置
 */
async function handleAtAll(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
): Promise<void> {
    if (event.message_type !== 'group' || !event.group_id) {
        await sendReply(ctx, event, '此命令只能在群聊中使用');
        return;
    }

    // 检查权限
    if (!isAdmin(event)) {
        await sendReply(ctx, event, '只有群主或管理员才能修改此设置');
        return;
    }

    const groupId = String(event.group_id);
    const action = args[0]?.toLowerCase();

    if (action === 'on' || action === '开启') {
        storage.setGroupAtAll(groupId, true);
        await sendReply(ctx, event, '已开启开播@全体功能');
    } else if (action === 'off' || action === '关闭') {
        storage.setGroupAtAll(groupId, false);
        await sendReply(ctx, event, '已关闭开播@全体功能');
    } else {
        const current = storage.getGroupAtAll(groupId);
        await sendReply(ctx, event, `当前@全体状态: ${current ? '开启' : '关闭'}\n用法: ${COMMAND_PREFIX} atall on/off`);
    }
}
