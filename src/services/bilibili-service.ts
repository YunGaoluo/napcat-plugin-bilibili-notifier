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

/** 单次批量查询的 UID 数量上限，避免 URL 过长或超出接口限制。 */
const LIVE_BATCH_SIZE = 50;

interface RawLiveRoom {
    room_id: number;
    uid: number;
    title: string;
    live_status: number;
    online: number;
    live_time: number;
    uname: string;
    face: string;
    cover_from_user: string;
    area_id: number;
    area_name: string;
    area_v2_parent_name: string;
    tag_name: string;
}

async function fetchLiveChunk(
    uids: number[], signal?: AbortSignal,
): Promise<Map<number, LiveRoomStatus>> {
    const result = new Map<number, LiveRoomStatus>();
    const urlParams = uids.map(uid => `uids[]=${uid}`).join('&');
    const response = await fetch(
        `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?${urlParams}`,
        { method: 'GET', signal: requestSignal(signal), headers: { ...BILI_HEADERS } },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json() as ApiResponse<Record<string, RawLiveRoom>>;
    if (data.code !== 0) throw new Error(`API Error: ${data.message}`);
    if (!data.data) {
        pluginState.logger.warn('(◕‿◕) API 返回数据为空');
        return result;
    }

    for (const uid of uids) {
        const roomData = data.data[String(uid)];
        if (!roomData) continue;
        result.set(uid, {
            roomId: roomData.room_id,
            uid: roomData.uid,
            title: roomData.title,
            liveStatus: roomData.live_status,
            online: roomData.online,
            liveTime: roomData.live_time,
            uname: roomData.uname,
            face: roomData.face,
            cover: roomData.cover_from_user,
            areaId: roomData.area_id,
            areaName: roomData.area_name,
            parentAreaName: roomData.area_v2_parent_name,
            tags: roomData.tag_name,
        });
    }
    return result;
}

/**
 * 获取直播间状态（批量接口）。
 * 按固定大小分块请求，订阅量增长时不会因 URL 过长导致整轮检查失败。
 */
export async function getLiveRoomStatusBatch(
    uids: number[], signal?: AbortSignal,
): Promise<Map<number, LiveRoomStatus>> {
    const result = new Map<number, LiveRoomStatus>();
    for (let index = 0; index < uids.length; index += LIVE_BATCH_SIZE) {
        const partial = await fetchLiveChunk(uids.slice(index, index + LIVE_BATCH_SIZE), signal);
        for (const [uid, status] of partial) result.set(uid, status);
    }
    if (pluginState.config.debug) {
        pluginState.logger.debug(`获取 ${result.size}/${uids.length} 个直播间状态`);
    }
    return result;
}

// ==================== 动态相关 API ====================

/** 动态发布时间，用于判断是否早于已知边界。 */
function publisherTs(item: DynamicItemRaw): number {
    return getModule(item.modules, 'MODULE_TYPE_AUTHOR')?.module_author?.pub_ts ?? 0;
}

/** 首次只读首页建立基线；随后向后翻页，直到遇到整页已知动态或读完。 */
export async function getUserDynamics(
    uid: number, knownIds?: ReadonlySet<string>, signal?: AbortSignal, knownBeforeTs?: number,
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
            ids.add(item.id_str);
            if (!dynamic) {
                pluginState.logger.warn(`(；′⌒\`) 跳过无法解析的动态 ${item.id_str}`);
                continue;
            }
            result.push(dynamic);
        }
        if (pluginState.config.debug) pluginState.logger.debug(`获取用户 ${uid} 动态: 本页 ${page.items.length} 条`);
        const isKnown = (item: DynamicItemRaw) =>
            (knownIds?.has(item.id_str) ?? false)
            || (knownBeforeTs !== undefined && publisherTs(item) <= knownBeforeTs);
        if (!knownIds || !page.has_more || page.items.every(isKnown)) break;
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
    | { module_type: 'MODULE_TYPE_STAT'; module_stat: ModuleStat }
    | { module_type: string; [key: string]: unknown };

interface CountValue {
    count?: number | string;
}

interface ModuleStat {
    like?: CountValue;
    comment?: CountValue;
    forward?: CountValue;
    reply?: CountValue;
}

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
        emoji?: {
            icon_url?: string;
        };
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
        stat?: {
            play?: number | string;
            danmaku?: number | string;
        };
    };
    major?: {
        type?: string;
        archive?: {
            aid: string;
            bvid: string;
            title: string;
            cover: string;
            desc: string;
            duration_text: string;
            jump_url: string;
            stat?: {
                play?: number | string;
                danmaku?: number | string;
            };
        };
        draw?: {
            id?: number;
            items: Array<{
                src: string;
                width: number;
                height: number;
            }>;
        };
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
        const drawItems = dynData.dyn_draw?.items ?? dynData.major?.draw?.items;
        const archive = dynData.dyn_archive ?? dynData.major?.archive;

        if (drawItems && drawItems.length > 0) {
            dynamic.draw = { items: drawItems };
        }

        if (archive) {
            dynamic.archive = {
                aid: archive.aid,
                bvid: archive.bvid,
                title: archive.title,
                cover: archive.cover,
                desc: archive.desc,
                duration_text: archive.duration_text,
                jump_url: archive.jump_url,
                play: toCount(archive.stat?.play),
                danmaku: toCount(archive.stat?.danmaku),
            };
        }

        if (dynData.type === 'MDL_DYN_TYPE_FORWARD' && dynData.dyn_forward?.item) {
            dynamic.orig = parseDynamicItem(dynData.dyn_forward.item);
        }
    }

    // 提取互动数据
    const statModule = getModule(item.modules, 'MODULE_TYPE_STAT');
    if (statModule?.module_stat) {
        const stat = statModule.module_stat;
        dynamic.stats = {
            like: toCount(stat.like?.count) ?? 0,
            comment: toCount(stat.comment?.count) ?? toCount(stat.reply?.count) ?? 0,
            forward: toCount(stat.forward?.count) ?? 0,
        };
    }

    return dynamic;
}

/** 接口计数字段可能为字符串，无法解析时返回 undefined。 */
function toCount(value: number | string | undefined): number | undefined {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : undefined;
}