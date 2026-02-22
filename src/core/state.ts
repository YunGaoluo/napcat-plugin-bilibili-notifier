/**
 * 全局状态管理模块（单例模式）
 *
 * 封装插件的运行时状态，提供在项目任意位置访问
 * ctx、logger 等对象的能力，无需逐层传递参数。
 *
 * 使用方法：
 *   import { pluginState } from '../core/state';
 *   pluginState.ctx.logger.info(...); // 使用日志
 */

import fs from 'fs';
import path from 'path';
import type { NapCatPluginContext, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin/types';
import { storage } from './storage';

// ==================== 插件全局状态类 ====================

class PluginState {
    /** NapCat 插件上下文（init 后可用） */
    private _ctx: NapCatPluginContext | null = null;

    /** 插件启动时间戳 */
    startTime: number = 0;

    /** 机器人自身 QQ 号 */
    selfId: string = '';

    /** 活跃的定时器 Map: jobId -> NodeJS.Timeout */
    timers: Map<string, ReturnType<typeof setInterval>> = new Map();

    /** 运行时统计 */
    stats = {
        processed: 0,
        todayProcessed: 0,
        lastUpdateDay: new Date().toDateString(),
    };

    /** 获取上下文（确保已初始化） */
    get ctx(): NapCatPluginContext {
        if (!this._ctx) throw new Error('PluginState 尚未初始化，请先调用 init()');
        return this._ctx;
    }

    /** 获取日志器的快捷方式 */
    get logger(): PluginLogger {
        return this.ctx.logger;
    }

    // ==================== 生命周期 ====================

    /**
     * 初始化（在 plugin_init 中调用）
     */
    init(ctx: NapCatPluginContext): void {
        this._ctx = ctx;
        this.startTime = Date.now();
        this.ensureDataDir();
        storage.loadAll();
        this.fetchSelfId();
    }

    /**
     * 获取机器人自身 QQ 号（异步，init 时自动调用）
     */
    private async fetchSelfId(): Promise<void> {
        try {
            const res = await this.ctx.actions.call(
                'get_login_info', {}, this.ctx.adapterName, this.ctx.pluginManager.config
            ) as { user_id?: number | string };
            if (res?.user_id) {
                this.selfId = String(res.user_id);
                this.logger.debug('(｡·ω·｡) 机器人 QQ: ' + this.selfId);
            }
        } catch (e) {
            this.logger.warn('(；′⌒`) 获取机器人 QQ 号失败:', e);
        }
    }

    /**
     * 清理（在 plugin_cleanup 中调用）
     */
    cleanup(): void {
        // 清理所有定时器
        for (const [jobId, timer] of this.timers) {
            clearInterval(timer);
            this.logger.debug(`(｡-ω-) 清理定时器: ${jobId}`);
        }
        this.timers.clear();
        this._ctx = null;
    }

    // ==================== 数据目录 ====================

    /** 确保数据目录存在 */
    private ensureDataDir(): void {
        const dataPath = this.ctx.dataPath;
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath, { recursive: true });
        }
    }

    /** 获取数据文件完整路径 */
    getDataFilePath(filename: string): string {
        return path.join(this.ctx.dataPath, filename);
    }

    // ==================== 通用数据文件读写 ====================

    /**
     * 读取 JSON 数据文件
     * 常用于订阅数据、定时任务配置、推送历史等持久化数据
     * @param filename 数据文件名（如 'subscriptions.json'）
     * @param defaultValue 文件不存在或解析失败时的默认值
     */
    loadDataFile<T>(filename: string, defaultValue: T): T {
        const filePath = this.getDataFilePath(filename);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch (e) {
            this.logger.warn('(；′⌒`) 读取数据文件 ' + filename + ' 失败:', e);
        }
        return defaultValue;
    }

    /**
     * 保存 JSON 数据文件
     * @param filename 数据文件名
     * @param data 要保存的数据
     */
    saveDataFile<T>(filename: string, data: T): void {
        const filePath = this.getDataFilePath(filename);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            this.logger.error('(╥﹏╥) 保存数据文件 ' + filename + ' 失败:', e);
        }
    }

    // ==================== 统计 ====================

    /**
     * 增加处理计数
     */
    incrementProcessed(): void {
        const today = new Date().toDateString();
        if (this.stats.lastUpdateDay !== today) {
            this.stats.todayProcessed = 0;
            this.stats.lastUpdateDay = today;
        }
        this.stats.todayProcessed++;
        this.stats.processed++;
    }

    // ==================== 工具方法 ====================

    /** 获取运行时长（毫秒） */
    getUptime(): number {
        return Date.now() - this.startTime;
    }

    /** 获取格式化的运行时长 */
    getUptimeFormatted(): string {
        const ms = this.getUptime();
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);

        if (d > 0) return `${d}天${h % 24}小时`;
        if (h > 0) return `${h}小时${m % 60}分钟`;
        if (m > 0) return `${m}分钟${s % 60}秒`;
        return `${s}秒`;
    }
}

/** 导出全局单例 */
export const pluginState = new PluginState();
