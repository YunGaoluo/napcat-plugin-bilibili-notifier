/**
 * 订阅数据存储管理模块
 *
 * 数据结构设计：
 * - 使用3个JSON文件分别存储不同类型的数据
 * - 支持双向查询：群/用户 -> 主播，主播 -> 群/用户
 * - 内存缓存 + 自动持久化
 *
 * 文件说明：
 * - streamers.json: 主播基本信息和直播状态
 * - group_subs.json: 群订阅配置和订阅列表
 * - user_subs.json: 用户订阅列表
 */

import { pluginState } from './state';

// ==================== 类型定义 ====================

/** 主播信息 */
export interface Streamer {
    /** B站UID */
    uid: number;
    /** 直播间ID */
    roomId: number;
    /** 主播昵称 */
    uname: string;
    /** 当前开播状态: 0=未开播, 1=直播中, 2=轮播中 */
    liveStatus: number;
    /** 开播时间戳（秒），未开播时为0 */
    liveTime: number;
    /** 直播间标题 */
    title?: string;
    /** 主播头像URL */
    face?: string;
    /** 封面图URL */
    cover?: string;
    /** 最后更新时间 */
    lastUpdateTime?: number;
}

/** 群订阅配置 */
export interface GroupSubscription {
    /** 群号 */
    groupId: string;
    /** 订阅的主播UID列表 */
    streamerUids: number[];
    /** 是否开启@全体 */
    enableAtAll: boolean;
    /** 自定义推送消息模板（可选） */
    pushTemplate?: string;
    /** 是否启用推送 */
    enabled: boolean;
}

/** 用户订阅配置 */
export interface UserSubscription {
    /** 用户QQ号 */
    userId: string;
    /** 订阅的主播UID列表 */
    streamerUids: number[];
}

/** 订阅关系索引 - 用于反向查询 */
export interface SubscriptionIndex {
    /** 主播UID -> 订阅该主播的群号列表 */
    streamerToGroups: Record<number, string[]>;
    /** 主播UID -> 订阅该主播的用户QQ列表 */
    streamerToUsers: Record<number, string[]>;
}

// ==================== 存储管理类 ====================

class SubscriptionStorage {
    /** 内存缓存：主播信息映射 uid -> Streamer */
    private streamers: Map<number, Streamer> = new Map();

    /** 内存缓存：群订阅配置 groupId -> GroupSubscription */
    private groupSubs: Map<string, GroupSubscription> = new Map();

    /** 内存缓存：用户订阅配置 userId -> UserSubscription */
    private userSubs: Map<string, UserSubscription> = new Map();

    /** 内存缓存：反向索引 */
    private index: SubscriptionIndex = {
        streamerToGroups: {},
        streamerToUsers: {},
    };

    /** 数据文件路径 */
    private readonly FILES = {
        streamers: 'streamers.json',
        groupSubs: 'group_subs.json',
        userSubs: 'user_subs.json',
    } as const;

    // ==================== 数据加载与保存 ====================

    /**
     * 加载所有数据文件到内存
     * 在插件初始化时调用
     */
    loadAll(): void {
        this.loadStreamers();
        this.loadGroupSubs();
        this.loadUserSubs();
        this.rebuildIndex();
        pluginState.logger.debug('✓ 订阅数据加载完成');
    }

    /** 加载主播数据 */
    private loadStreamers(): void {
        const data = pluginState.loadDataFile<Record<string, Streamer>>(this.FILES.streamers, {});
        this.streamers.clear();
        for (const [uid, streamer] of Object.entries(data)) {
            if (streamer && typeof streamer.uid === 'number') {
                this.streamers.set(Number(uid), streamer);
            }
        }
    }

    /** 加载群订阅数据 */
    private loadGroupSubs(): void {
        const data = pluginState.loadDataFile<Record<string, GroupSubscription>>(this.FILES.groupSubs, {});
        this.groupSubs.clear();
        for (const [groupId, sub] of Object.entries(data)) {
            if (sub && Array.isArray(sub.streamerUids)) {
                this.groupSubs.set(groupId, {
                    groupId,
                    streamerUids: sub.streamerUids,
                    enableAtAll: sub.enableAtAll ?? false,
                    enabled: sub.enabled ?? true,
                    pushTemplate: sub.pushTemplate,
                });
            }
        }
    }

    /** 加载用户订阅数据 */
    private loadUserSubs(): void {
        const data = pluginState.loadDataFile<Record<string, UserSubscription>>(this.FILES.userSubs, {});
        this.userSubs.clear();
        for (const [userId, sub] of Object.entries(data)) {
            if (sub && Array.isArray(sub.streamerUids)) {
                this.userSubs.set(userId, {
                    userId,
                    streamerUids: sub.streamerUids,
                });
            }
        }
    }

    /** 保存主播数据 */
    saveStreamers(): void {
        const data: Record<string, Streamer> = {};
        for (const [uid, streamer] of this.streamers) {
            data[uid] = streamer;
        }
        pluginState.saveDataFile(this.FILES.streamers, data);
    }

    /** 保存群订阅数据 */
    saveGroupSubs(): void {
        const data: Record<string, GroupSubscription> = {};
        for (const [groupId, sub] of this.groupSubs) {
            data[groupId] = sub;
        }
        pluginState.saveDataFile(this.FILES.groupSubs, data);
    }

    /** 保存用户订阅数据 */
    saveUserSubs(): void {
        const data: Record<string, UserSubscription> = {};
        for (const [userId, sub] of this.userSubs) {
            data[userId] = sub;
        }
        pluginState.saveDataFile(this.FILES.userSubs, data);
    }

    /** 保存所有数据 */
    saveAll(): void {
        this.saveStreamers();
        this.saveGroupSubs();
        this.saveUserSubs();
    }

    // ==================== 索引管理 ====================

    /**
     * 重建反向索引
     * 用于快速查询：某个主播被哪些群和用户订阅
     */
    private rebuildIndex(): void {
        this.index = {
            streamerToGroups: {},
            streamerToUsers: {},
        };

        // 构建主播到群的索引
        for (const [groupId, sub] of this.groupSubs) {
            for (const uid of sub.streamerUids) {
                if (!this.index.streamerToGroups[uid]) {
                    this.index.streamerToGroups[uid] = [];
                }
                if (!this.index.streamerToGroups[uid].includes(groupId)) {
                    this.index.streamerToGroups[uid].push(groupId);
                }
            }
        }

        // 构建主播到用户的索引
        for (const [userId, sub] of this.userSubs) {
            for (const uid of sub.streamerUids) {
                if (!this.index.streamerToUsers[uid]) {
                    this.index.streamerToUsers[uid] = [];
                }
                if (!this.index.streamerToUsers[uid].includes(userId)) {
                    this.index.streamerToUsers[uid].push(userId);
                }
            }
        }
    }

    /** 更新单个主播的索引 */
    private updateStreamerIndex(uid: number): void {
        // 清除该主播的旧索引
        this.index.streamerToGroups[uid] = [];
        this.index.streamerToUsers[uid] = [];

        // 重新构建该主播的索引
        for (const [groupId, sub] of this.groupSubs) {
            if (sub.streamerUids.includes(uid)) {
                this.index.streamerToGroups[uid].push(groupId);
            }
        }

        for (const [userId, sub] of this.userSubs) {
            if (sub.streamerUids.includes(uid)) {
                this.index.streamerToUsers[uid].push(userId);
            }
        }
    }

    // ==================== 主播管理 ====================

    /**
     * 添加或更新主播信息
     */
    setStreamer(streamer: Streamer): void {
        this.streamers.set(streamer.uid, {
            ...streamer,
            lastUpdateTime: Date.now(),
        });
        this.saveStreamers();
    }

    /**
     * 批量添加或更新主播
     */
    setStreamers(streamers: Streamer[]): void {
        const now = Date.now();
        for (const streamer of streamers) {
            this.streamers.set(streamer.uid, {
                ...streamer,
                lastUpdateTime: now,
            });
        }
        this.saveStreamers();
    }

    /**
     * 获取主播信息
     */
    getStreamer(uid: number): Streamer | undefined {
        return this.streamers.get(uid);
    }

    /**
     * 获取所有主播
     */
    getAllStreamers(): Streamer[] {
        return Array.from(this.streamers.values());
    }

    /**
     * 根据直播间ID获取主播
     */
    getStreamerByRoomId(roomId: number): Streamer | undefined {
        for (const streamer of this.streamers.values()) {
            if (streamer.roomId === roomId) {
                return streamer;
            }
        }
        return undefined;
    }

    /**
     * 删除主播（同时清理所有订阅关系）
     */
    removeStreamer(uid: number): boolean {
        if (!this.streamers.has(uid)) return false;

        // 从所有群订阅中移除
        for (const [groupId, sub] of this.groupSubs) {
            const idx = sub.streamerUids.indexOf(uid);
            if (idx !== -1) {
                sub.streamerUids.splice(idx, 1);
            }
        }

        // 从所有用户订阅中移除
        for (const [userId, sub] of this.userSubs) {
            const idx = sub.streamerUids.indexOf(uid);
            if (idx !== -1) {
                sub.streamerUids.splice(idx, 1);
            }
        }

        // 删除主播数据
        this.streamers.delete(uid);

        // 清理索引
        delete this.index.streamerToGroups[uid];
        delete this.index.streamerToUsers[uid];

        this.saveAll();
        return true;
    }

    /**
     * 更新主播直播状态
     */
    updateStreamerStatus(uid: number, liveStatus: number, liveTime?: number): boolean {
        const streamer = this.streamers.get(uid);
        if (!streamer) return false;

        streamer.liveStatus = liveStatus;
        if (liveTime !== undefined) {
            streamer.liveTime = liveTime;
        }
        streamer.lastUpdateTime = Date.now();

        this.saveStreamers();
        return true;
    }

    // ==================== 群订阅管理 ====================

    /**
     * 获取群订阅配置
     */
    getGroupSub(groupId: string): GroupSubscription | undefined {
        return this.groupSubs.get(groupId);
    }

    /**
     * 获取或创建群订阅配置
     */
    private getOrCreateGroupSub(groupId: string): GroupSubscription {
        let sub = this.groupSubs.get(groupId);
        if (!sub) {
            sub = {
                groupId,
                streamerUids: [],
                enableAtAll: false,
                enabled: true,
            };
            this.groupSubs.set(groupId, sub);
        }
        return sub;
    }

    /**
     * 群订阅主播
     * @returns 是否成功（如果已订阅则返回false）
     */
    subscribeGroup(groupId: string, uid: number): boolean {
        // 确保主播存在
        if (!this.streamers.has(uid)) {
            throw new Error(`主播不存在: ${uid}`);
        }

        const sub = this.getOrCreateGroupSub(groupId);

        // 检查是否已订阅
        if (sub.streamerUids.includes(uid)) {
            return false;
        }

        sub.streamerUids.push(uid);
        this.updateStreamerIndex(uid);
        this.saveGroupSubs();
        return true;
    }

    /**
     * 群取消订阅主播
     * @returns 是否成功（如果未订阅则返回false）
     */
    unsubscribeGroup(groupId: string, uid: number): boolean {
        const sub = this.groupSubs.get(groupId);
        if (!sub) return false;

        const idx = sub.streamerUids.indexOf(uid);
        if (idx === -1) return false;

        sub.streamerUids.splice(idx, 1);
        this.updateStreamerIndex(uid);
        this.saveGroupSubs();
        return true;
    }

    /**
     * 获取群订阅的所有主播
     */
    getGroupSubscribedStreamers(groupId: string): Streamer[] {
        const sub = this.groupSubs.get(groupId);
        if (!sub) return [];

        return sub.streamerUids
            .map(uid => this.streamers.get(uid))
            .filter((s): s is Streamer => s !== undefined);
    }

    /**
     * 设置群@全体功能
     */
    setGroupAtAll(groupId: string, enable: boolean): void {
        const sub = this.getOrCreateGroupSub(groupId);
        sub.enableAtAll = enable;
        this.saveGroupSubs();
    }

    /**
     * 获取群@全体设置
     */
    getGroupAtAll(groupId: string): boolean {
        return this.groupSubs.get(groupId)?.enableAtAll ?? false;
    }

    /**
     * 设置群推送开关
     */
    setGroupEnabled(groupId: string, enabled: boolean): void {
        const sub = this.getOrCreateGroupSub(groupId);
        sub.enabled = enabled;
        this.saveGroupSubs();
    }

    /**
     * 获取所有启用了订阅的群
     */
    getEnabledGroups(): GroupSubscription[] {
        return Array.from(this.groupSubs.values()).filter(sub => sub.enabled);
    }

    /**
     * 获取所有有订阅的群列表
     */
    getAllGroupSubs(): GroupSubscription[] {
        return Array.from(this.groupSubs.values());
    }

    // ==================== 用户订阅管理 ====================

    /**
     * 获取用户订阅
     */
    getUserSub(userId: string): UserSubscription | undefined {
        return this.userSubs.get(userId);
    }

    /**
     * 获取或创建用户订阅
     */
    private getOrCreateUserSub(userId: string): UserSubscription {
        let sub = this.userSubs.get(userId);
        if (!sub) {
            sub = {
                userId,
                streamerUids: [],
            };
            this.userSubs.set(userId, sub);
        }
        return sub;
    }

    /**
     * 用户订阅主播
     */
    subscribeUser(userId: string, uid: number): boolean {
        // 确保主播存在
        if (!this.streamers.has(uid)) {
            throw new Error(`主播不存在: ${uid}`);
        }

        const sub = this.getOrCreateUserSub(userId);

        // 检查是否已订阅
        if (sub.streamerUids.includes(uid)) {
            return false;
        }

        sub.streamerUids.push(uid);
        this.updateStreamerIndex(uid);
        this.saveUserSubs();
        return true;
    }

    /**
     * 用户取消订阅主播
     */
    unsubscribeUser(userId: string, uid: number): boolean {
        const sub = this.userSubs.get(userId);
        if (!sub) return false;

        const idx = sub.streamerUids.indexOf(uid);
        if (idx === -1) return false;

        sub.streamerUids.splice(idx, 1);
        this.updateStreamerIndex(uid);
        this.saveUserSubs();
        return true;
    }

    /**
     * 获取用户订阅的所有主播
     */
    getUserSubscribedStreamers(userId: string): Streamer[] {
        const sub = this.userSubs.get(userId);
        if (!sub) return [];

        return sub.streamerUids
            .map(uid => this.streamers.get(uid))
            .filter((s): s is Streamer => s !== undefined);
    }

    /**
     * 获取所有有订阅的用户
     */
    getAllUserSubs(): UserSubscription[] {
        return Array.from(this.userSubs.values());
    }

    // ==================== 反向查询 ====================

    /**
     * 获取订阅了该主播的所有群
     */
    getStreamerSubscribedGroups(uid: number): GroupSubscription[] {
        const groupIds = this.index.streamerToGroups[uid] ?? [];
        return groupIds
            .map(id => this.groupSubs.get(id))
            .filter((s): s is GroupSubscription => s !== undefined);
    }

    /**
     * 获取订阅了该主播的所有用户
     */
    getStreamerSubscribedUsers(uid: number): UserSubscription[] {
        const userIds = this.index.streamerToUsers[uid] ?? [];
        return userIds
            .map(id => this.userSubs.get(id))
            .filter((s): s is UserSubscription => s !== undefined);
    }

    /**
     * 获取订阅了该主播且启用了推送的群（用于开播推送）
     */
    getStreamerEnabledGroups(uid: number): GroupSubscription[] {
        return this.getStreamerSubscribedGroups(uid).filter(sub => sub.enabled);
    }

    /**
     * 检查主播是否有任何订阅
     */
    hasAnySubscribers(uid: number): boolean {
        const groupCount = this.index.streamerToGroups[uid]?.length ?? 0;
        const userCount = this.index.streamerToUsers[uid]?.length ?? 0;
        return groupCount > 0 || userCount > 0;
    }

    /**
     * 获取所有需要推送开播通知的群（按主播分组）
     * @returns Map<主播UID, 群配置列表>
     */
    getAllPushTargets(): Map<number, GroupSubscription[]> {
        const result = new Map<number, GroupSubscription[]>();

        for (const uid of this.streamers.keys()) {
            const groups = this.getStreamerEnabledGroups(uid);
            if (groups.length > 0) {
                result.set(uid, groups);
            }
        }

        return result;
    }

    // ==================== 统计信息 ====================

    /**
     * 获取统计数据
     */
    getStats(): {
        streamerCount: number;
        groupSubCount: number;
        userSubCount: number;
        totalGroupSubscriptions: number;
        totalUserSubscriptions: number;
    } {
        let totalGroupSubscriptions = 0;
        for (const sub of this.groupSubs.values()) {
            totalGroupSubscriptions += sub.streamerUids.length;
        }

        let totalUserSubscriptions = 0;
        for (const sub of this.userSubs.values()) {
            totalUserSubscriptions += sub.streamerUids.length;
        }

        return {
            streamerCount: this.streamers.size,
            groupSubCount: this.groupSubs.size,
            userSubCount: this.userSubs.size,
            totalGroupSubscriptions,
            totalUserSubscriptions,
        };
    }
}

// ==================== 导出单例 ====================

export const storage = new SubscriptionStorage();
