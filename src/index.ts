/**
 * B站直播动态推送插件 - 主入口
 *
 * 导出 PluginModule 接口定义的生命周期函数，NapCat 加载插件时会调用这些函数。
 *
 * 生命周期：
 *   plugin_init        → 插件加载时调用（必选）
 *   plugin_onmessage   → 收到事件时调用（需通过 post_type 判断事件类型）
 *   plugin_cleanup     → 插件卸载/重载时调用
 *
 * @license MIT
 */

import type {
    PluginModule,
    PluginConfigSchema,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';
import { buildConfigSchema } from './config';
import { pluginState } from './core/state';
import { handleMessage } from './handlers/message-handler';
import { startLiveMonitor, stopLiveMonitor } from './services/live-monitor-service';
import { startDynamicMonitor, stopDynamicMonitor } from './services/dynamic-monitor-service';
import { clearNotificationService } from './services/notification-service';
import type { PluginConfig } from './types';


// ==================== 配置 UI Schema ====================

/** NapCat WebUI 读取此导出来展示配置面板 */
export let plugin_config_ui: PluginConfigSchema = [];

// ==================== 生命周期函数 ====================

/**
 * 插件初始化（必选）
 * 加载配置并启动监控
 */
export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
    try {
        // 1. 初始化全局状态
        pluginState.init(ctx);

        ctx.logger.info('插件初始化中...');

        // 2. 生成配置 Schema（用于 NapCat WebUI 配置面板）
        plugin_config_ui = buildConfigSchema(ctx);

        // 5. 启动直播监控服务
        startLiveMonitor(ctx);

        // 6. 启动动态监控服务
        startDynamicMonitor(ctx);

        ctx.logger.info('插件初始化完成');
    } catch (error) {
        ctx.logger.error('插件初始化失败:', error);
        await Promise.allSettled([stopLiveMonitor(), stopDynamicMonitor()]);
        clearNotificationService();
        pluginState.cleanup();
        throw error;
    }
};

/**
 * 消息/事件处理（可选）
 * 收到事件时调用，需通过 post_type 判断是否为消息事件
 */
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    // 仅处理消息事件
    if (event.post_type !== EventType.MESSAGE) return;
    // 委托给消息处理器
    await handleMessage(ctx, event);
};


/**
 * 插件卸载/重载（可选）
 * 必须清理定时器、关闭连接等资源
 */
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        const results = await Promise.allSettled([stopLiveMonitor(), stopDynamicMonitor()]);
        for (const result of results) {
            if (result.status === 'rejected') ctx.logger.warn('停止监控时出错:', result.reason);
        }
    } finally {
        clearNotificationService();
        pluginState.cleanup();
    }
    ctx.logger.info('插件已卸载');
};

// ==================== 配置管理钩子 ====================

/** 获取当前配置（由 NapCat WebUI 调用） */
export const plugin_get_config: PluginModule['plugin_get_config'] = async (_ctx) => {
    return pluginState.config;
};

/** 设置配置（完整替换，由 NapCat WebUI 调用） */
export const plugin_set_config: PluginModule['plugin_set_config'] = async (ctx, config) => {
    pluginState.replaceConfig(config as PluginConfig);
    ctx.logger.info('配置已通过 WebUI 更新');
};

/** 配置变更回调（单个配置项修改时触发） */
export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
    ctx, _ui, key, value, _currentConfig
) => {
    try {
        pluginState.updateConfig({ [key]: value });
        if (pluginState.config.debug) ctx.logger.debug(`配置项 ${key} 已更新`);
    } catch (err) {
        ctx.logger.error(`更新配置项 ${key} 失败:`, err);
        throw err;
    }
};
