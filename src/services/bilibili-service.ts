/**
 * B站API服务
 * 封装B站HTTP接口调用
 */

import type { LiveRoomStatus, ApiResponse, DynamicInfo, DynamicAuthor, DynamicContent } from '../types';
import { DynamicType } from '../types';
import { pluginState } from '../core/state';

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 10000;

/** B站请求Headers */
const BILI_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
   
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

// ==================== 动态相关 API ====================

/**
 * 获取用户空间动态列表
 * API: https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space
 * @param uid 用户UID
 * @returns 动态列表（按时间倒序，最新的在最前面）
 */
export async function getUserDynamics(uid: number): Promise<DynamicInfo[]> {
    const result: DynamicInfo[] = [];

    const startTime = Date.now();

    try {
        const url = `https://api.bilibili.com/x/polymer/web-dynamic/desktop/v1/feed/space?host_mid=${uid}`;

        // 记录请求日志（包含请求头）
        const requestHeaders = { ...BILI_HEADERS };
        pluginState.logger.debug(`(｡･ω･｡) 获取用户动态列表请求: uid=${uid}, url=${url}, headers=${JSON.stringify(requestHeaders)}`);

        const response = await fetch(url, {
            method: 'GET',
            headers: requestHeaders,
        });

        if (!response.ok) {
            pluginState.logger.error(`(╥﹏╥) 获取用户动态列表响应错误: HTTP ${response.status}`);
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json() as ApiResponse<{
            items: DynamicItemRaw[];
        }>;

        // 记录响应日志（包含完整响应数据）
        pluginState.logger.debug(`(｡･ω･｡) 获取用户动态列表响应: uid=${uid}, code=${data.code}, message=${data.message || 'success'}, items=${data.data?.items?.length ?? 0}`);
        pluginState.logger.debug(`(｡･ω･｡) 响应数据: ${JSON.stringify(data, null, 2)}`);

        if (data.code !== 0) {
            throw new Error(`API Error: ${data.message}`);
        }

        if (!data.data?.items) {
            pluginState.logger.warn(`(◕‿◕) 用户 ${uid} 动态列表为空`);
            return result;
        }

        // 解析动态列表
        for (const item of data.data.items) {
            try {
                const dynamic = parseDynamicItem(item);
                if (dynamic !== undefined) {
                    result.push(dynamic);
                    pluginState.logger.debug(`(｡･ω･｡) 解析动态成功: id=${dynamic.id}, type=${dynamic.type}, author=${dynamic.author.name}`);
                } else {
                    pluginState.logger.warn(`(◕‿◕) 解析动态失败: id=${item.id_str}, type=${item.type}`);
                }
            } catch (parseError) {
                pluginState.logger.error(`(╥﹏╥) 解析动态异常: id=${item.id_str}, type=${item.type}, error=`, parseError);
            }
        }

        const duration = Date.now() - startTime;
        pluginState.logger.debug(`(✿◠‿◠) 获取用户动态列表完成: uid=${uid}, 成功解析=${result.length}条, 原始数据=${data.data.items.length}条, 耗时=${duration}ms`);
    } catch (error) {
        const duration = Date.now() - startTime;
        pluginState.logger.error(`(╥﹏╥) 获取用户 ${uid} 动态失败, 耗时=${duration}ms:`, error);
    }

    return result;
}

/**
 * 新API响应中的Module类型
 */
type ModuleItem =
    | { module_type: 'MODULE_TYPE_AUTHOR'; module_author: ModuleAuthor }
    | { module_type: 'MODULE_TYPE_DESC'; module_desc: ModuleDesc }
    | { module_type: 'MODULE_TYPE_DYNAMIC'; module_dynamic: ModuleDynamic }
    | { module_type: 'MODULE_TYPE_STAT'; module_stat: unknown }
    | { module_type: string; [key: string]: unknown };

interface ModuleAuthor {
    user: {
        mid: number;
        name: string;
        face: string;
    };
    pub_time: string;
    pub_ts: number;
}

interface ModuleDesc {
    text: string;
    rich_text_nodes: Array<{
        type: string;
        text: string;
        orig_text?: string;
        jump_url?: string;
    }>;
}

interface ModuleDynamic {
    type: string;
    dyn_draw?: {
        id: number;
        items: Array<{
            src: string;
            width: number;
            height: number;
        }>;
    };
    dyn_archive?: {
        aid: string;
        bvid: string;
        title: string;
        cover: string;
        desc: string;
        duration_text: string;
        jump_url: string;
    };
    dyn_forward?: {
        item: DynamicItemRaw;
    };
}

interface DynamicItemRaw {
    id_str: string;
    type: string;
    modules: ModuleItem[];
}

/**
 * 从modules数组中提取指定类型的module
 */
function getModule<T extends ModuleItem['module_type']>(
    modules: ModuleItem[],
    type: T
): Extract<ModuleItem, { module_type: T }> | undefined {
    return modules.find((m): m is Extract<ModuleItem, { module_type: T }> => m.module_type === type);
}

/**
 * 解析动态数据结构（适配新API格式）
 */
function parseDynamicItem(item: DynamicItemRaw): DynamicInfo | undefined {
    const type = item.type as DynamicType;

    // 提取作者信息
    const authorModule = getModule(item.modules, 'MODULE_TYPE_AUTHOR');
    if (!authorModule?.module_author) {
        pluginState.logger.warn(`(◕‿◕) 动态 ${item.id_str} 缺少作者信息`);
        return undefined;
    }
    const authorData = authorModule.module_author;
    const author: DynamicAuthor = {
        mid: authorData.user.mid,
        name: authorData.user.name,
        face: authorData.user.face,
        pub_time: authorData.pub_time,
        pub_ts: authorData.pub_ts,
    };

    // 提取文字描述
    const descModule = getModule(item.modules, 'MODULE_TYPE_DESC');
    const content: DynamicContent = {
        text: descModule?.module_desc?.text ?? '',
        rich_text_nodes: descModule?.module_desc?.rich_text_nodes ?? [],
    };

    const dynamic: DynamicInfo = {
        id: item.id_str,
        type,
        author,
        content,
    };

    // 提取动态内容（图片、视频等）
    const dynamicModule = getModule(item.modules, 'MODULE_TYPE_DYNAMIC');
    if (dynamicModule?.module_dynamic) {
        const dynData = dynamicModule.module_dynamic;

        switch (dynData.type) {
            case 'MDL_DYN_TYPE_DRAW':
                // 图文动态
                if (dynData.dyn_draw) {
                    dynamic.draw = {
                        items: dynData.dyn_draw.items,
                    };
                }
                break;

            case 'MDL_DYN_TYPE_ARCHIVE':
                // 视频投稿
                if (dynData.dyn_archive) {
                    dynamic.archive = {
                        aid: dynData.dyn_archive.aid,
                        bvid: dynData.dyn_archive.bvid,
                        title: dynData.dyn_archive.title,
                        cover: dynData.dyn_archive.cover,
                        desc: dynData.dyn_archive.desc,
                        duration_text: dynData.dyn_archive.duration_text,
                        jump_url: dynData.dyn_archive.jump_url,
                    };
                }
                break;

            case 'MDL_DYN_TYPE_FORWARD':
                // 转发动态
                if (dynData.dyn_forward?.item) {
                    dynamic.orig = parseDynamicItem(dynData.dyn_forward.item);
                }
                break;
        }
    }

    return dynamic;
}