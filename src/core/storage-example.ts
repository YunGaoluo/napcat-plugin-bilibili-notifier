/**
 * 存储模块使用示例
 *
 * 这个文件演示如何使用 storage 模块来管理订阅数据
 */

import { storage, type Streamer } from './storage';

// ==================== 示例1: 添加主播 ====================

/**
 * 添加新主播到数据库
 */
export function exampleAddStreamer(): void {
    const newStreamer: Streamer = {
        uid: 123456,
        roomId: 789012,
        uname: '示例主播',
        liveStatus: 0, // 未开播
        liveTime: 0,
        title: '直播间标题',
        face: 'https://example.com/face.jpg',
        cover: 'https://example.com/cover.jpg',
    };

    storage.setStreamer(newStreamer);
    console.log(`已添加主播: ${newStreamer.uname}`);
}

// ==================== 示例2: 群订阅管理 ====================

/**
 * 群订阅主播
 */
export function exampleGroupSubscribe(groupId: string, uid: number): void {
    try {
        const success = storage.subscribeGroup(groupId, uid);
        if (success) {
            console.log(`群 ${groupId} 成功订阅主播 ${uid}`);
        } else {
            console.log(`群 ${groupId} 已经订阅了主播 ${uid}`);
        }
    } catch (error) {
        console.error('订阅失败:', error);
    }
}

/**
 * 设置群@全体功能
 */
export function exampleSetGroupAtAll(groupId: string, enable: boolean): void {
    storage.setGroupAtAll(groupId, enable);
    console.log(`群 ${groupId} @全体功能: ${enable ? '开启' : '关闭'}`);
}

/**
 * 获取群订阅的所有主播
 */
export function exampleGetGroupStreamers(groupId: string): void {
    const streamers = storage.getGroupSubscribedStreamers(groupId);
    console.log(`群 ${groupId} 订阅了 ${streamers.length} 个主播:`);
    for (const s of streamers) {
        console.log(`  - ${s.uname} (UID: ${s.uid})`);
    }
}

// ==================== 示例3: 用户订阅管理 ====================

/**
 * 用户订阅主播
 */
export function exampleUserSubscribe(userId: string, uid: number): void {
    try {
        const success = storage.subscribeUser(userId, uid);
        if (success) {
            console.log(`用户 ${userId} 成功订阅主播 ${uid}`);
        } else {
            console.log(`用户 ${userId} 已经订阅了主播 ${uid}`);
        }
    } catch (error) {
        console.error('订阅失败:', error);
    }
}

/**
 * 获取用户订阅的所有主播
 */
export function exampleGetUserStreamers(userId: string): void {
    const streamers = storage.getUserSubscribedStreamers(userId);
    console.log(`用户 ${userId} 订阅了 ${streamers.length} 个主播:`);
    for (const s of streamers) {
        console.log(`  - ${s.uname} (UID: ${s.uid})`);
    }
}

// ==================== 示例4: 反向查询 ====================

/**
 * 查询订阅了某主播的所有群和用户
 */
export function exampleGetStreamerSubscribers(uid: number): void {
    const groups = storage.getStreamerSubscribedGroups(uid);
    const users = storage.getStreamerSubscribedUsers(uid);

    console.log(`主播 ${uid} 的订阅情况:`);
    console.log(`  订阅的群: ${groups.length} 个`);
    for (const g of groups) {
        console.log(`    - 群 ${g.groupId} (@全体: ${g.enableAtAll ? '开' : '关'})`);
    }

    console.log(`  订阅的用户: ${users.length} 个`);
    for (const u of users) {
        console.log(`    - 用户 ${u.userId}`);
    }
}

// ==================== 示例5: 开播推送场景 ====================

/**
 * 主播开播时的处理流程
 */
export function exampleOnStreamStart(uid: number): void {
    // 1. 获取主播信息
    const streamer = storage.getStreamer(uid);
    if (!streamer) {
        console.error(`主播 ${uid} 不存在`);
        return;
    }

    // 2. 更新直播状态
    storage.updateStreamerStatus(uid, 1, Math.floor(Date.now() / 1000));

    // 3. 获取需要推送的群（启用了推送的）
    const groups = storage.getStreamerEnabledGroups(uid);

    // 4. 遍历推送
    for (const group of groups) {
        const atAll = group.enableAtAll ? '@全体 ' : '';
        const message = `${atAll}${streamer.uname} 开播啦！\n标题: ${streamer.title}\nhttps://live.bilibili.com/${streamer.roomId}`;

        console.log(`推送到群 ${group.groupId}: ${message}`);
        // 这里调用实际的推送API
    }
}

// ==================== 示例6: 获取统计信息 ====================

/**
 * 获取订阅统计
 */
export function exampleGetStats(): void {
    const stats = storage.getStats();
    console.log('订阅统计:');
    console.log(`  主播总数: ${stats.streamerCount}`);
    console.log(`  有订阅的群: ${stats.groupSubCount} 个`);
    console.log(`  有订阅的用户: ${stats.userSubCount} 个`);
    console.log(`  群订阅关系数: ${stats.totalGroupSubscriptions}`);
    console.log(`  用户订阅关系数: ${stats.totalUserSubscriptions}`);
}

// ==================== 示例7: 批量导入主播 ====================

/**
 * 批量导入主播数据
 */
export function exampleBatchImportStreamers(): void {
    const streamers: Streamer[] = [
        {
            uid: 111111,
            roomId: 222222,
            uname: '主播A',
            liveStatus: 0,
            liveTime: 0,
        },
        {
            uid: 333333,
            roomId: 444444,
            uname: '主播B',
            liveStatus: 1,
            liveTime: Math.floor(Date.now() / 1000),
        },
    ];

    storage.setStreamers(streamers);
    console.log(`成功导入 ${streamers.length} 个主播`);
}

// ==================== 示例8: 完整的订阅流程 ====================

/**
 * 完整的订阅流程示例
 */
export function exampleFullSubscribeFlow(): void {
    // 1. 先添加主播
    const streamer: Streamer = {
        uid: 777777,
        roomId: 888888,
        uname: '测试主播',
        liveStatus: 0,
        liveTime: 0,
    };
    storage.setStreamer(streamer);
    console.log('步骤1: 添加主播到数据库');

    // 2. 群订阅
    storage.subscribeGroup('123456789', streamer.uid);
    storage.setGroupAtAll('123456789', true);
    console.log('步骤2: 群123456789订阅了主播，并开启@全体');

    // 3. 用户订阅
    storage.subscribeUser('987654321', streamer.uid);
    console.log('步骤3: 用户987654321订阅了主播');

    // 4. 查询订阅情况
    const groups = storage.getStreamerSubscribedGroups(streamer.uid);
    const users = storage.getStreamerSubscribedUsers(streamer.uid);
    console.log(`步骤4: 主播被 ${groups.length} 个群和 ${users.length} 个用户订阅`);

    // 5. 模拟开播
    storage.updateStreamerStatus(streamer.uid, 1, Math.floor(Date.now() / 1000));
    console.log('步骤5: 主播开播，状态已更新');

    // 6. 获取推送目标
    const pushTargets = storage.getStreamerEnabledGroups(streamer.uid);
    console.log(`步骤6: 需要推送到 ${pushTargets.length} 个群`);
}
