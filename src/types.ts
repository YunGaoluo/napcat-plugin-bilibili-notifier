/**
 * 类型定义文件
 * 定义插件内部使用的接口和类型
 *
 * 注意：OneBot 相关类型（OB11Message, OB11PostSendMsg 等）
 * 以及插件框架类型（NapCatPluginContext, PluginModule 等）
 * 均来自 napcat-types 包，无需在此重复定义。
 */

// ==================== API 响应 ====================

/**
 * 统一 API 响应格式
 */
export interface ApiResponse<T = unknown> {
    /** 状态码，0 表示成功，-1 表示失败 */
    code: number;
    /** 错误信息（仅错误时返回） */
    message?: string;
    /** 响应数据（仅成功时返回） */
    data?: T;
}

/** 直播间状态 */
export interface LiveRoomStatus {
    /** 直播间ID */
    roomId: number;
    /** UP主UID */
    uid: number;
    /** 直播间标题 */
    title: string;
    /** 直播状态: 0=未开播, 1=直播中, 2=轮播中 */
    liveStatus: number;
    /** 在线人数 */
    online: number;
    /** 开播时间（时间戳，秒） */
    liveTime: number;
    /** 主播名称 */
    uname: string;
    /** 主播头像 */
    face: string;
    /** 封面图 */
    cover: string;
    /** 分区ID */
    areaId: number;
    /** 分区名称 */
    areaName: string;
    /** 父分区名称 */
    parentAreaName: string;
    /** 标签 */
    tags: string;
}

// ==================== 动态相关类型 ====================

/** 动态类型 */
export enum DynamicType {
    /** 转发 */
    FORWARD = 'DYNAMIC_TYPE_FORWARD',
    /** 视频投稿 */
    AV = 'DYNAMIC_TYPE_AV',
    /** 图文动态 */
    DRAW = 'DYNAMIC_TYPE_DRAW',
    /** 文字动态 */
    WORD = 'DYNAMIC_TYPE_WORD',
    /** 专栏 */
    ARTICLE = 'DYNAMIC_TYPE_ARTICLE',
    /** 音频 */
    MUSIC = 'DYNAMIC_TYPE_MUSIC',
}

/** 动态作者信息 */
export interface DynamicAuthor {
    mid: number;
    name: string;
    face: string;
    pub_time: string;
    pub_ts: number;
}

/** 视频动态内容 */
export interface DynamicArchive {
    aid: string;
    bvid: string;
    title: string;
    cover: string;
    desc: string;
    duration_text: string;
    jump_url: string;
}

/** 图文动态内容 */
export interface DynamicDraw {
    items: Array<{
        src: string;
        width: number;
        height: number;
    }>;
}

/** 动态内容 */
export interface DynamicContent {
    text: string;
    rich_text_nodes: Array<{
        type: string;
        text: string;
        orig_text?: string;
        jump_url?: string;
    }>;
}

/** 动态信息 */
export interface DynamicInfo {
    /** 动态ID */
    id: string;
    /** 动态类型 */
    type: DynamicType;
    /** 作者信息 */
    author: DynamicAuthor;
    /** 动态内容 */
    content: DynamicContent;
    /** 视频信息（仅视频动态） */
    archive?: DynamicArchive;
    /** 图片信息（仅图文动态） */
    draw?: DynamicDraw;
    /** 转发源动态（仅转发类型） */
    orig?: DynamicInfo;
    /** 动态链接 */
    jump_url?: string;
}
