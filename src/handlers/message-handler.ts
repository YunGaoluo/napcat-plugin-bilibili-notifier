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
import { getLiveRoomStatusBatch } from '../services/bilibili-service';
import { buildLiveStartMessage, getLiveMonitor, hasNotifiedLive } from '../services/live-monitor-service';
import { createNotificationService } from '../services/notification-service';
import { storage } from '../core/storage';
import type { Streamer } from '../core/storage';

/** 单个群或用户可订阅的主播数量上限。 */
const MAX_SUBSCRIPTIONS_PER_TARGET = 50;
/** 全局跟踪的主播数量上限，限制恶意刷订阅造成的轮询压力。 */
const MAX_TRACKED_STREAMERS = 500;
/** 同一用户在同一会话中执行订阅/取消订阅的最小间隔。 */
const COMMAND_COOLDOWN_MS = 3000;
/** 列表消息的分段长度上限，避免超过 QQ 单条消息长度。 */
const LIST_CHUNK_LIMIT = 3000;

// ==================== 命令解析 ====================


interface ParsedCommand {
    subCommand: string;
    args: string[];
}

function parseCommand(message: string): ParsedCommand | null {
    if (!message.startsWith(pluginState.config.commandPrefix)) return null;
    const suffix = message.slice(pluginState.config.commandPrefix.length);
    if (suffix && !/^\s/.test(suffix)) return null;

    const parts = message.slice(pluginState.config.commandPrefix.length).trim().split(/\s+/);
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

/** 判断发送者是否是配置中的主人 QQ。 */
export function isSuperuser(event: OB11Message): boolean {
    const userId = String(event.user_id ?? '');
    if (!userId) return false;
    const superusers = String(pluginState.config?.superusers ?? '')
        .split(/[,，]/)
        .map(value => value.trim())
        .filter(Boolean);
    return superusers.includes(userId);
}

/**
 * 检查是否有管理员权限
 * - 群聊中：群主、管理员或配置的 superusers 之一
 * - 私聊消息：默认返回 true（同时会检查 superusers）
 */
export function isAdmin(event: OB11Message): boolean {
    const role = (event.sender as Record<string, unknown>)?.role;
    if (event.message_type === 'group' && (role === 'admin' || role === 'owner')) {
        return true;
    }
    if (isSuperuser(event)) return true;
    // 私聊默认放行（兼容原有逻辑），群聊则拒绝
    return event.message_type !== 'group';
}

// ==================== 消息处理主函数 ====================

/**
 * 消息处理主函数
 * 在这里实现你的命令处理逻辑
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        if (!pluginState.config.enabled) return;
        if (event.message_type === 'group' && !pluginState.isGroupEnabled(String(event.group_id))) return;
        const rawMessage = event.raw_message || '';

        const parsed = parseCommand(rawMessage);
        if (!parsed) return;
        if (pluginState.config.debug) ctx.logger.debug(`处理命令: ${parsed.subCommand}`);

        const { subCommand, args } = parsed;

        switch (subCommand) {
            case 'help': {
                const helpText = [
                    `[= B站直播订阅插件帮助 =]`,
                    `${pluginState.config.commandPrefix} help - 显示帮助信息`,
                    ``,
                    `【订阅管理】`,
                    `${pluginState.config.commandPrefix} 订阅 <UID> - 订阅主播(群/私聊)`,
                    `${pluginState.config.commandPrefix} 删除 <UID> - 取消订阅主播`,
                    `${pluginState.config.commandPrefix} 列表 - 查看订阅列表`,
                    ``,
                    `【群管理】`,
                    `${pluginState.config.commandPrefix} atall on/off - 开启/关闭@全体`,
                    ``,
                    `【主人】`,
                    `${pluginState.config.commandPrefix} 订阅总览 - 查看全局订阅情况(仅主人私聊)`,
                    ``,
                    `【示例】`,
                    `${pluginState.config.commandPrefix} 订阅 UID:407800065`,
                    `${pluginState.config.commandPrefix} 订阅 407800065`,
                    `${pluginState.config.commandPrefix} 删除 UID:407800065`,
                ].join('\n');
                await sendReply(ctx, event, helpText);
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

            case '删除':
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

            case '订阅总览':
            case '总览':
            case 'alllist': {
                await handleAllSubscriptions(ctx, event);
                pluginState.incrementProcessed();
                break;
            }

            default: {
                break;
            }
        }
    } catch (error) {
        await sendReply(ctx, event, '操作失败，请稍后重试或联系管理员查看日志');
        pluginState.logger.error('处理消息时出错:', error);
    }
}

/**
 * 解析 UID 参数
 * 支持两种格式：
 * 1. UID:xxx 格式，如 "UID:407800065"
 * 2. 纯数字格式，如 "407800065"
 * @param arg 参数字符串
 * @returns 解析后的UID数字，如果格式不正确则返回null
 */
function parseUidArg(arg: string): number | null {
    // 首先尝试匹配 UID: 开头格式
    const uidPrefixMatch = arg.match(/^UID:(\d+)$/i);
    if (uidPrefixMatch) {
        const uid = parseInt(uidPrefixMatch[1], 10);
        if (Number.isSafeInteger(uid) && uid > 0) {
            return uid;
        }
    }

    // 然后尝试匹配纯数字格式
    const numberMatch = arg.match(/^\d+$/);
    if (numberMatch) {
        const uid = parseInt(arg, 10);
        if (Number.isSafeInteger(uid) && uid > 0) {
            return uid;
        }
    }

    return null;
}


// ==================== 业务逻辑 ====================

/**
 * 向新订阅目标补发一次开播通知。
 *
 * 仅当该主播的开播事件已经发过时才补发；若尚未发出，下一轮轮询会统一推送给
 * 所有订阅者（包含新目标），此处直接返回以避免重复。
 */
async function sendLiveCatchUp(ctx: NapCatPluginContext, uid: number, target: string): Promise<void> {
    const streamer = storage.getStreamer(uid);
    if (!streamer || streamer.liveStatus !== 1) return;
    try {
        const status = (await getLiveRoomStatusBatch([uid])).get(uid);
        if (!status || status.liveStatus !== 1) return;
        const service = createNotificationService(ctx);
        const eventId = `live:${uid}:start:${status.liveTime}`;
        if (!hasNotifiedLive(uid)) {
            // 开播事件可能刚入队但尚未落盘：直接补上新目标；否则交给下一轮轮询统一推送
            service.addTarget(eventId, target);
            return;
        }
        const groupId = target.startsWith('group:') ? target.slice('group:'.length) : null;
        service.enqueue(
            `${eventId}:catchup:${target}`,
            uid,
            buildLiveStartMessage(status.uname, status),
            groupId !== null && storage.getGroupAtAll(groupId),
            [target],
        );
    } catch (error) {
        ctx.logger.warn(`补发开播通知失败 (UID: ${uid}):`, error);
    }
}

/**
 * 处理订阅命令
 * 支持群订阅和用户私聊订阅
 * 格式: #blive 订阅 UID:407800065
 */
async function handleSubscribe(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
): Promise<void> {
    if (event.message_type === 'group' && !isAdmin(event)) {
        await sendReply(ctx, event, '只有群主或管理员才能订阅主播');
        return;
    }
    if (args.length === 0) {
        await sendReply(ctx, event, `用法: ${pluginState.config.commandPrefix} 订阅 UID:<数字>\n例如: ${pluginState.config.commandPrefix} 订阅 UID:407800065`);
        return;
    }

    // 解析 UID 参数
    const uid = parseUidArg(args[0]);
    if (uid === null) {
        await sendReply(ctx, event, '格式错误，UID必须是数字\n例如: 407800065 或 UID:407800065');
        return;
    }

    // 频率限制：同一用户在同一会话中的订阅操作至少间隔 3 秒
    const cooldownKey = event.message_type === 'group'
        ? `group:${event.group_id}:${event.user_id}`
        : `private:${event.user_id}`;
    const now = Date.now();
    if (now - (pluginState.commandCooldowns.get(cooldownKey) ?? 0) < COMMAND_COOLDOWN_MS) {
        await sendReply(ctx, event, '操作过于频繁，请稍后再试');
        return;
    }
    pluginState.commandCooldowns.set(cooldownKey, now);

    // 检查主播是否已在数据库中
    let streamer = storage.getStreamer(uid);

    const trackedCount = storage.getAllStreamers()
        .filter(item => storage.hasAnySubscribers(item.uid)).length;
    if (!streamer && trackedCount >= MAX_TRACKED_STREAMERS) {
        await sendReply(ctx, event, `监控主播数量已达上限（${MAX_TRACKED_STREAMERS}），无法继续订阅`);
        return;
    }

    // 如果不在，尝试从B站获取信息
    if (!streamer) {
        const liveRoomData = await getLiveRoomStatusBatch([uid]);
        const roomStatus = liveRoomData.get(uid);
        if (!roomStatus) {
            await sendReply(ctx, event, `未找到UID为 ${uid} 的主播信息`);
            return;
        }
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
        const existing = storage.getGroupSub(groupId);
        if (!existing?.streamerUids.includes(uid)
            && (existing?.streamerUids.length ?? 0) >= MAX_SUBSCRIPTIONS_PER_TARGET) {
            await sendReply(ctx, event, `本群订阅数量已达上限（${MAX_SUBSCRIPTIONS_PER_TARGET}），请先删除部分订阅`);
            return;
        }

        const success = storage.subscribeGroup(groupId, uid);
        if (success) {
            await sendReply(ctx, event, `群订阅成功\n主播: ${streamer.uname}\nUID: ${uid}\n直播间: https://live.bilibili.com/${streamer.roomId}`);
            await sendLiveCatchUp(ctx, uid, `group:${groupId}`);
        } else {
            await sendReply(ctx, event, `本群已经订阅了 ${streamer.uname}`);
        }
    } else if (event.message_type === 'private' && event.user_id) {
        // 用户私聊订阅
        const userId = String(event.user_id);
        const existing = storage.getUserSub(userId);
        if (!existing?.streamerUids.includes(uid)
            && (existing?.streamerUids.length ?? 0) >= MAX_SUBSCRIPTIONS_PER_TARGET) {
            await sendReply(ctx, event, `订阅数量已达上限（${MAX_SUBSCRIPTIONS_PER_TARGET}），请先删除部分订阅`);
            return;
        }

        const success = storage.subscribeUser(userId, uid);
        if (success) {
            await sendReply(ctx, event, `订阅成功\n主播: ${streamer.uname}\nUID: ${uid}\n直播间: https://live.bilibili.com/${streamer.roomId}`);
            await sendLiveCatchUp(ctx, uid, `private:${userId}`);
        } else {
            await sendReply(ctx, event, `您已经订阅了 ${streamer.uname}`);
        }
    }
}

/**
 * 处理取消订阅命令
 * 格式: #blive 删除 UID:407800065
 */
async function handleUnsubscribe(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
): Promise<void> {
    if (event.message_type === 'group' && !isAdmin(event)) {
        await sendReply(ctx, event, '只有群主或管理员才能取消订阅');
        return;
    }
    if (args.length === 0) {
        await sendReply(ctx, event, `用法: ${pluginState.config.commandPrefix} 删除 UID:<数字>\n例如: ${pluginState.config.commandPrefix} 删除 UID:407800065`);
        return;
    }

    // 解析 UID 参数
    const uid = parseUidArg(args[0]);
    if (uid === null) {
        await sendReply(ctx, event, '格式错误，UID必须是数字\n例如: 407800065 或 UID:407800065');
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


        const success = storage.unsubscribeGroup(groupId, uid);
        if (success) {
            await sendReply(ctx, event, `已取消订阅\n主播: ${streamer.uname}\nUID: ${uid}`);
            if (!storage.hasAnySubscribers(uid)) getLiveMonitor()?.forgetStreamer(uid);
        } else {
            await sendReply(ctx, event, `本群没有订阅 ${streamer.uname}`);
        }
    } else if (event.message_type === 'private' && event.user_id) {
        // 用户取消订阅
        const userId = String(event.user_id);
        const success = storage.unsubscribeUser(userId, uid);
        if (success) {
            await sendReply(ctx, event, `已取消订阅\n主播: ${streamer.uname}\nUID: ${uid}`);
            if (!storage.hasAnySubscribers(uid)) getLiveMonitor()?.forgetStreamer(uid);
        } else {
            await sendReply(ctx, event, `您没有订阅 ${streamer.uname}`);
        }
    }
}

/** 按消息长度切分内容发送，避免单条消息超过平台限制后被静默丢弃。 */
async function sendChunkedMessage(
    ctx: NapCatPluginContext,
    event: OB11Message,
    header: string,
    blocks: string[],
    footer: string[] = [],
): Promise<void> {
    let buffer = header;
    const flush = async (): Promise<boolean> => {
        if (!buffer) return true;
        const sent = await sendReply(ctx, event, buffer);
        buffer = '';
        return sent;
    };

    for (const block of blocks) {
        if (buffer.length + block.length > LIST_CHUNK_LIMIT && !await flush()) return;
        buffer += block;
    }
    for (const line of footer) {
        if (buffer.length + line.length + 1 > LIST_CHUNK_LIMIT && !await flush()) return;
        buffer += line + '\n';
    }
    await flush();
}

/** 发送主播订阅列表，超长时自动分片。 */
async function sendStreamerList(
    ctx: NapCatPluginContext,
    event: OB11Message,
    title: string,
    streamers: Streamer[],
    footer: string[] = [],
): Promise<void> {
    const blocks = streamers.map((streamer, index) => {
        const status = streamer.liveStatus === 1 ? '直播中' : streamer.liveStatus === 2 ? '轮播中' : '未开播';
        let block = `\n${index + 1}. ${streamer.uname}\n   UID: ${streamer.uid} | ${status}\n`;
        if (streamer.liveStatus === 1 && streamer.liveTime > 0) {
            block += `   已开播: ${Math.floor((Date.now() / 1000 - streamer.liveTime) / 60)} 分钟\n`;
        }
        return block + `   https://live.bilibili.com/${streamer.roomId}\n`;
    });
    await sendChunkedMessage(ctx, event, `[= ${title} =]\n共 ${streamers.length} 个主播\n`, blocks, footer);
}

/** 主人私聊查询：每个主播被哪些群和用户订阅。 */
async function handleAllSubscriptions(
    ctx: NapCatPluginContext,
    event: OB11Message,
): Promise<void> {
    if (event.message_type !== 'private') {
        await sendReply(ctx, event, '此命令仅支持主人私聊使用');
        return;
    }
    if (!isSuperuser(event)) {
        await sendReply(ctx, event, '只有主人才能使用此命令');
        return;
    }

    const rows = storage.getAllStreamers()
        .map(streamer => ({
            streamer,
            groups: storage.getStreamerSubscribedGroups(streamer.uid),
            users: storage.getStreamerSubscribedUsers(streamer.uid),
        }))
        .filter(row => row.groups.length + row.users.length > 0)
        .sort((a, b) =>
            (b.groups.length + b.users.length) - (a.groups.length + a.users.length)
            || a.streamer.uid - b.streamer.uid);

    if (rows.length === 0) {
        await sendReply(ctx, event, '当前没有任何群或用户订阅主播');
        return;
    }

    const groupCount = new Set(rows.flatMap(row => row.groups.map(group => group.groupId))).size;
    const userCount = new Set(rows.flatMap(row => row.users.map(user => user.userId))).size;
    const blocks = rows.map(({ streamer, groups, users }) => {
        let block = `\n${streamer.uname} (UID: ${streamer.uid})\n`;
        if (groups.length > 0) {
            const labels = groups.map(group =>
                !group.enabled || !pluginState.isGroupEnabled(group.groupId)
                    ? `${group.groupId}(已暂停)`
                    : group.groupId);
            block += `  群(${groups.length}): ${labels.join(', ')}\n`;
        }
        if (users.length > 0) {
            block += `  私聊(${users.length}): ${users.map(user => user.userId).join(', ')}\n`;
        }
        return block;
    });

    await sendChunkedMessage(
        ctx,
        event,
        `[= 全局订阅总览 =]\n主播 ${rows.length} 个 | 群 ${groupCount} 个 | 用户 ${userCount} 个\n`,
        blocks,
    );
}

/**
 * 处理查看订阅列表命令
 */
async function handleList(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _args: string[],
): Promise<void> {
    if (event.message_type === 'group' && event.group_id) {
        const groupId = String(event.group_id);
        const streamers = storage.getGroupSubscribedStreamers(groupId);
        const groupSub = storage.getGroupSub(groupId);

        if (streamers.length === 0) {
            await sendReply(ctx, event, '本群还没有订阅任何主播\n使用 ' + pluginState.config.commandPrefix + ' 订阅 <UID> 来订阅\n例如: ' + pluginState.config.commandPrefix + ' 订阅 407800065');
            return;
        }

        const footer = groupSub
            ? ['[群设置]', `@全体: ${groupSub.enableAtAll ? '开启' : '关闭'}`]
            : [];
        await sendStreamerList(ctx, event, '本群订阅列表', streamers, footer);
    } else if (event.message_type === 'private' && event.user_id) {
        const userId = String(event.user_id);
        const streamers = storage.getUserSubscribedStreamers(userId);

        if (streamers.length === 0) {
            await sendReply(ctx, event, '您还没有订阅任何主播\n使用 ' + pluginState.config.commandPrefix + ' 订阅 <UID> 来订阅\n例如: ' + pluginState.config.commandPrefix + ' 订阅 407800065');
            return;
        }

        await sendStreamerList(ctx, event, '您的订阅列表', streamers);
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
        await sendReply(ctx, event, `当前@全体状态: ${current ? '开启' : '关闭'}\n用法: ${pluginState.config.commandPrefix} atall on/off`);
    }
}
