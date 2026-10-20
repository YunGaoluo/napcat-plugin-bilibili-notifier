/**
 * B站API服务
 * 封装B站HTTP接口调用
 */

import type { LiveRoomStatus, ApiResponse, DynamicInfo, DynamicAuthor, DynamicContent } from '../types';
import { DynamicType } from '../types';
import { pluginState } from '../core/state';

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 10000;

function requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
export async function getLiveRoomStatusBatch(uids: number[], signal?: AbortSignal): Promise<Map<number, LiveRoomStatus>> {
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
            signal: requestSignal(signal),
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
        if (pluginState.config.debug) pluginState.logger.debug(`获取 ${result.size}/${uids.length} 个直播间状态`);
    } catch (error) {
        throw error;
    }
    // 返回最终的直播间状态结果
    return result;
}

// ==================== 动态相关 API ====================

/** 首次只读首页建立基线；随后向后翻页，直到遇到整页已知动态或读完。 */
export async function getUserDynamics(
    uid: number, knownIds?: ReadonlySet<string>, signal?: AbortSignal,
): Promise<DynamicInfo[]> {
    const result: DynamicInfo[] = [];
    const offsets = new Set<string>();
    const ids = new Set<string>();
    let offset = '';
    while (true) {
        signal?.throwIfAborted();
        const url = new URL('https://api.bilibili.com/x/polymer/web-dynamic/desktop/v1/feed/space');
        url.searchParams.set('host_mid', String(uid));
        if (offset) url.searchParams.set('offset', offset);
        const response = await fetch(url, {
            method: 'GET', headers: BILI_HEADERS, signal: requestSignal(signal),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as ApiResponse<{
            items: DynamicItemRaw[];
            has_more?: boolean | number;
            offset?: string;
        }>;
        if (data.code !== 0) throw new Error(`API Error: ${data.message}`);
        if (!data.data || !Array.isArray(data.data.items)) throw new Error('动态接口返回无效数据');
        const page = data.data;
        for (const item of page.items) {
            if (ids.has(item.id_str)) continue;
            const dynamic = parseDynamicItem(item);
            if (!dynamic) throw new Error(`动态 ${item.id_str} 解析失败`);
            result.push(dynamic);
            ids.add(item.id_str);
        }
        if (pluginState.config.debug) pluginState.logger.debug(`获取用户 ${uid} 动态: 本页 ${page.items.length} 条`);
        if (!knownIds || !page.has_more || page.items.every(item => knownIds.has(item.id_str))) break;
        if (!page.offset || offsets.has(page.offset)) throw new Error('动态接口分页游标未推进');
        offsets.add(page.offset);
        offset = page.offset;
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
    dyn_live?: {
        id: number;
        cover: string;
        live_type: number;
        live_status: number;
        title: string;
        jump_url: string;
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