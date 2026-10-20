/**
 * 动态卡片渲染
 *
 * 将动态数据转换为 B 站风格的 HTML，再交给 Gotenberg 截图。
 * 图片资源先在本地下载并内联，避免 Chromium 因防盗链取不到图。
 */

import { pluginState } from '../core/state';
import type { DynamicInfo } from '../types';

const IMAGE_TIMEOUT_MS = 3000;
const RENDER_TIMEOUT_MS = 5000;
const MAX_DRAW_IMAGES = 9;
const MAX_ORIG_IMAGES = 3;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_CARD_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 动态类型对应的动作描述，用于头部时间行。 */
const TYPE_ACTIONS: Record<string, string> = {
    DYNAMIC_TYPE_AV: '投稿了视频',
    DYNAMIC_TYPE_DRAW: '发布了动态',
    DYNAMIC_TYPE_WORD: '发布了动态',
    DYNAMIC_TYPE_ARTICLE: '投稿了专栏',
    DYNAMIC_TYPE_MUSIC: '发布了音频',
    DYNAMIC_TYPE_FORWARD: '转发了动态',
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatCount(value: number | undefined): string {
    if (value === undefined) return '-';
    if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
    return String(value);
}

function formatRelativeTime(timestamp: number): string {
    if (!timestamp) return '';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
    if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}天前`;
    return new Date(timestamp * 1000).toLocaleDateString('zh-CN');
}

/** B 站图片 CDN 支持追加尺寸参数，用缩略图避免把原图塞进卡片。 */
function thumbnail(url: string | undefined, size: number): string | undefined {
    if (!url || url.includes('@') || !/hdslb\.com/.test(url)) return url;
    return `${url}@${size}w_${size}h_1c.webp`;
}

/** 下载图片并转为 data URL；失败时返回 null，由调用方降级。 */
async function inlineImage(url: string | undefined): Promise<string | null> {
    if (!url) return null;
    const target = url.startsWith('//') ? `https:${url}` : url;
    try {
        const response = await fetch(target, {
            headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' },
            signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
        const mime = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
}

/** 将富文本节点转为 HTML，表情按图片渲染，其余按纯文本转义。 */
async function renderRichText(dynamic: DynamicInfo): Promise<string> {
    const nodes = dynamic.content.rich_text_nodes ?? [];
    const parts = nodes.length > 0
        ? await Promise.all(nodes.map(async node => {
            const icon = await inlineImage(node.emoji?.icon_url);
            return icon
                ? `<img class="emoji" src="${icon}" alt="">`
                : escapeHtml(node.text);
        }))
        : [escapeHtml(dynamic.content.text)];
    return parts.join('').replace(/\n/g, '<br>');
}

function renderImageGrid(images: string[]): string {
    const inlined = images.filter(Boolean);
    if (inlined.length === 0) return '';
    if (inlined.length === 1) {
        return `<div class="single"><img src="${inlined[0]}" alt=""></div>`;
    }
    const columns = inlined.length === 2 ? 2 : 3;
    return `<div class="grid cols-${columns}">${inlined.map(src => `<img src="${src}" alt="">`).join('')}</div>`;
}

async function buildCardHtml(dynamic: DynamicInfo, uname: string): Promise<string> {
    const author = dynamic.author;
    const action = TYPE_ACTIONS[dynamic.type] ?? '发布了动态';
    const relative = formatRelativeTime(author.pub_ts);
    const avatar = await inlineImage(thumbnail(author.face, 100));
    const body = await renderRichText(dynamic);

    const drawSources = (dynamic.draw?.items ?? [])
        .slice(0, MAX_DRAW_IMAGES)
        .map(item => thumbnail(item.src, 480));
    const drawInline = (await Promise.all(drawSources.map(inlineImage))).map(src => src ?? '');
    const drawHtml = renderImageGrid(drawInline);

    let archiveHtml = '';
    if (dynamic.archive) {
        const cover = await inlineImage(thumbnail(dynamic.archive.cover, 480));
        archiveHtml = `
        <div class="video">
            ${cover ? `<div class="thumb"><img src="${cover}" alt="">${dynamic.archive.duration_text ? `<span class="duration">${escapeHtml(dynamic.archive.duration_text)}</span>` : ''}</div>` : ''}
            <div class="video-info">
                <div class="video-title">${escapeHtml(dynamic.archive.title)}</div>
                ${dynamic.archive.desc ? `<div class="video-desc">${escapeHtml(dynamic.archive.desc)}</div>` : ''}
                <div class="video-meta">
                    ${dynamic.archive.play !== undefined ? `<span>播放 ${formatCount(dynamic.archive.play)}</span>` : ''}
                    ${dynamic.archive.danmaku !== undefined ? `<span>弹幕 ${formatCount(dynamic.archive.danmaku)}</span>` : ''}
                </div>
            </div>
        </div>`;
    }

    let forwardHtml = '';
    if (dynamic.orig) {
        const orig = dynamic.orig;
        const origAvatar = await inlineImage(thumbnail(orig.author.face, 80));
        const origBody = await renderRichText(orig);
        const origImages = (orig.draw?.items ?? [])
            .slice(0, MAX_ORIG_IMAGES)
            .map(item => thumbnail(item.src, 240));
        const origInline = (await Promise.all(origImages.map(inlineImage))).map(src => src ?? '');
        const origGrid = renderImageGrid(origInline);
        forwardHtml = `
        <div class="forward">
            <div class="forward-head">
                ${origAvatar ? `<img class="forward-avatar" src="${origAvatar}" alt="">` : ''}
                <span>@${escapeHtml(orig.author.name)}</span>
            </div>
            <div class="forward-text">${origBody}</div>
            ${origGrid}
            ${orig.archive ? `<div class="forward-title">《${escapeHtml(orig.archive.title)}》</div>` : ''}
        </div>`;
    }

    const stats = dynamic.stats ?? { like: 0, comment: 0, forward: 0 };
    const width = pluginState.config.cardWidth;

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; background: #ffffff; }
    .card { width: ${width - 24}px; border: 1px solid #e3e5e7; border-radius: 12px; padding: 16px; background: #fff;
            font-family: "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; color: #18191c; }
    .head { display: flex; align-items: center; gap: 10px; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #f1f2f3; }
    .name { color: #fb7299; font-size: 16px; font-weight: 600; }
    .meta { color: #9499a0; font-size: 13px; margin-top: 2px; }
    .text { margin: 12px 0 0; font-size: 15px; line-height: 1.62; word-break: break-word; }
    .emoji { width: 20px; height: 20px; vertical-align: -4px; }
    .single { margin-top: 10px; }
    .single img { width: 100%; max-height: 420px; object-fit: cover; border-radius: 8px; display: block; }
    .grid { display: grid; gap: 4px; margin-top: 10px; }
    .grid.cols-2 { grid-template-columns: repeat(2, 1fr); }
    .grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
    .grid img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; display: block; }
    .video { display: flex; gap: 10px; margin-top: 10px; border: 1px solid #e3e5e7; border-radius: 8px; padding: 8px; }
    .thumb { position: relative; width: 200px; flex: 0 0 200px; }
    .thumb img { width: 100%; height: 112px; object-fit: cover; border-radius: 6px; display: block; }
    .duration { position: absolute; right: 4px; bottom: 4px; background: rgba(0,0,0,.6); color: #fff;
                font-size: 11px; padding: 1px 4px; border-radius: 3px; }
    .video-info { flex: 1; min-width: 0; }
    .video-title { font-size: 15px; font-weight: 600; line-height: 1.4; }
    .video-desc { color: #9499a0; font-size: 13px; line-height: 1.45; margin-top: 4px;
                  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .video-meta { color: #9499a0; font-size: 12px; margin-top: 6px; display: flex; gap: 14px; }
    .forward { margin-top: 10px; background: #f6f7f8; border-radius: 8px; padding: 10px; }
    .forward-head { display: flex; align-items: center; gap: 6px; color: #61666d; font-size: 13px; }
    .forward-avatar { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; }
    .forward-text { margin-top: 6px; font-size: 14px; line-height: 1.55; }
    .forward-title { margin-top: 6px; font-size: 13px; color: #18191c; }
    .forward .grid img { aspect-ratio: 1 / 1; }
    .stats { display: flex; gap: 34px; margin-top: 14px; color: #9499a0; font-size: 13px; align-items: center; }
    .stats span { display: inline-flex; align-items: center; gap: 5px; }
</style>
</head>
<body>
    <div class="card">
        <div class="head">
            ${avatar ? `<img class="avatar" src="${avatar}" alt="">` : '<div class="avatar"></div>'}
            <div>
                <div class="name">${escapeHtml(uname || author.name)}</div>
                <div class="meta">${escapeHtml(relative)}${relative ? ' · ' : ''}${escapeHtml(action)}</div>
            </div>
        </div>
        ${body ? `<div class="text">${body}</div>` : ''}
        ${drawHtml}
        ${archiveHtml}
        ${forwardHtml}
        <div class="stats">
            <span><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M14 9V5l7 7-7 7v-4H4V9z"/></svg>${formatCount(stats.forward)}</span>
            <span><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v12H8l-4 4z"/></svg>${formatCount(stats.comment)}</span>
            <span><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2 10h4v11H2zm7 11h7a3 3 0 0 0 3-3l1-6a2 2 0 0 0-2-2h-4l1-4a2 2 0 0 0-2-2l-4 7z"/></svg>${formatCount(stats.like)}</span>
        </div>
    </div>
</body>
</html>`;
}

let renderInFlight = 0;

/**
 * 渲染动态卡片并返回可直接发送的 base64 图片地址。
 * 渲染失败、未启用或并发超限时返回 null，由调用方回退为文本推送。
 */
export async function renderDynamicCard(dynamic: DynamicInfo, uname: string): Promise<string | null> {
    const config = pluginState.config;
    if (!config.renderDynamicCard) return null;
    if (renderInFlight >= 2) return null;

    renderInFlight += 1;
    try {
        const html = await buildCardHtml(dynamic, uname);
        const boundary = `----napcat-card-${Date.now().toString(16)}`;
        const chunks: Buffer[] = [];
        const appendField = (name: string, value: string) => {
            chunks.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'
            ));
        };
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="index.html"\r\n` +
            'Content-Type: text/html\r\n\r\n', 'utf8'
        ));
        chunks.push(Buffer.from(html, 'utf8'));
        chunks.push(Buffer.from('\r\n', 'utf8'));
        appendField('format', 'png');
        appendField('width', String(config.cardWidth));
        appendField('deviceScaleFactor', '2');
        // 截图默认只覆盖视口，按卡片元素裁剪才能得到自适应高度
        appendField('selector', '.card');
        chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

        const response = await fetch(`${config.gotenbergUrl}/forms/chromium/screenshot/html`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body: Buffer.concat(chunks),
            signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Gotenberg HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) throw new Error('Gotenberg 返回空图片');
        if (buffer.length > MAX_CARD_BYTES) throw new Error(`渲染图片过大 (${buffer.length} bytes)`);
        return `base64://${buffer.toString('base64')}`;
    } catch (error) {
        pluginState.logger.warn(`(；′⌒\`) 动态卡片渲染失败，回退文本: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    } finally {
        renderInFlight -= 1;
    }
}
