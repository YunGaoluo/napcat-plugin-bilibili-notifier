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
