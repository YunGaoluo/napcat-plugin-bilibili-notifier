/**
 * B站API服务
 * 封装B站HTTP接口调用
 */

import type { LiveRoomStatus, ApiResponse } from '../types';
import { pluginState } from '../core/state';

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 10000;

/** B站请求Headers */
const BILI_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://live.bilibili.com/',
};

/**
 * 获取直播间状态（批量接口）
 * 通过B站API批量查询多个UP主的直播间状态信息
 * @param uids UP主UID数组
 * @returns Promise<Map<number, LiveRoomStatus>> 返回包含直播间状态的Map，key为UID
 */
export async function getLiveRoomStatusBatch(uids: number[]): Promise<Map<number, LiveRoomStatus>> {
    // 初始化结果Map，用于存储查询到的直播间状态
    const result = new Map<number, LiveRoomStatus>();

    // 如果传入的UID数组为空，直接返回空结果
    if (uids.length === 0) return result;

    try {
        // 构造URL参数字符串
        const urlParams = uids.map(uid => `uids[]=${uid}`).join('&');
        const url = `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?${urlParams}`;


        // 发起GET请求到B站API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                ...BILI_HEADERS,  // 使用预定义的请求头
            },
        });

        // 检查HTTP响应状态，非2xx状态码抛出错误
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        // 解析响应JSON数据并进行类型断言
        const data = await response.json() as ApiResponse<Record<string, {
            room_id: number;           // 直播间ID
            uid: number;              // UP主UID
            title: string;            // 直播间标题
            live_status: number;      // 直播状态(0=未开播,1=直播中,2=轮播中)
            online: number;           // 在线人数
            live_time: number;        // 开播时间戳
            uname: string;            // 主播昵称
            face: string;             // 主播头像URL
            cover_from_user: string;  // 直播间封面
            area_id: number;          // 分区ID
            area_name: string;        // 分区名称
            area_v2_parent_name: string; // 父分区名称
            tag_name: string;         // 标签名称
        }>>;

        // 检查API返回的状态码，非0表示请求失败
        if (data.code !== 0) {
            throw new Error(`API Error: ${data.message}`);
        }

        // 遍历所有请求的UID，获取对应的直播间数据
        for (const uid of uids) {
            // 关键安全检查：确保data.data存在，避免访问undefined属性
            if (!data.data) {
                pluginState.logger.warn('(◕‿◕) API 返回数据为空');
                return result;  // 数据为空时直接返回已收集的结果
            }

            // 从响应数据中获取当前UID对应的直播间信息
            const roomData = data.data[String(uid)];

            // 如果找到了对应的直播间数据，则将其转换为标准格式并存入结果Map
            if (roomData) {
                result.set(uid, {
                    roomId: roomData.room_id,              // 直播间ID
                    uid: roomData.uid,                     // UP主UID
                    title: roomData.title,                 // 直播间标题
                    liveStatus: roomData.live_status,      // 直播状态
                    online: roomData.online,               // 在线人数
                    liveTime: roomData.live_time,          // 开播时间
                    uname: roomData.uname,                 // 主播名称
                    face: roomData.face,                   // 主播头像
                    cover: roomData.cover_from_user,       // 直播间封面
                    areaId: roomData.area_id,              // 分区ID
                    areaName: roomData.area_name,          // 分区名称
                    parentAreaName: roomData.area_v2_parent_name, // 父分区名称
                    tags: roomData.tag_name,               // 标签
                });
            }
        }

        // 输出详细日志
        pluginState.logger.debug(`(｡･ω･｡) 获取 ${result.size}/${uids.length} 个直播间状态`);
    } catch (error) {
        // 捕获并记录所有异常错误
        pluginState.logger.error('(╥﹏╥) 获取直播间状态失败:', error);
    }

    // 返回最终的直播间状态结果
    return result;
}