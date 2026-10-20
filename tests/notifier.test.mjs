import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginState } from '../src/core/state.ts';
import { storage } from '../src/core/storage.ts';
import { handleMessage } from '../src/handlers/message-handler.ts';
import { plugin_on_config_change } from '../src/index.ts';
import { LiveMonitorService } from '../src/services/live-monitor-service.ts';
import { DynamicMonitorService } from '../src/services/dynamic-monitor-service.ts';
import { createNotificationService, clearNotificationService } from '../src/services/notification-service.ts';
import { getUserDynamics, getLiveRoomStatusBatch } from '../src/services/bilibili-service.ts';

const originalFetch = globalThis.fetch;
let directory, ctx, sent, delivered, requests, monitors, sendAction, fetchAction, pages, liveStatus;
const uid = 42;
const groupEvent = (raw_message, role = 'admin', group_id = 100) => ({
    post_type: 'message', message_type: 'group', group_id, user_id: 200,
    raw_message, sender: { role },
});
const room = () => ({
    uid, room_id: 142, live_status: liveStatus, live_time: 1700000000,
    uname: 'Test UP', title: 'Test live', face: '', cover_from_user: '',
    online: 1, area_id: 1, area_name: 'area', area_v2_parent_name: 'parent', tag_name: '',
});
const dynamic = (id, pub_ts = 100, type = 'DYNAMIC_TYPE_WORD') => ({
    id_str: id, type, modules: [
        { module_type: 'MODULE_TYPE_AUTHOR', module_author: {
            user: { mid: uid, name: 'Test UP', face: '' }, pub_time: '', pub_ts,
        } },
        { module_type: 'MODULE_TYPE_DESC', module_desc: { text: `content ${id}`, rich_text_nodes: [] } },
    ],
});
const response = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
const queue = () => pluginState.loadDataFile('notification_queue.json', {});
const text = params => Array.isArray(params.message)
    ? params.message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('')
    : params.message;
function seed(groups = ['100'], users = []) {
    storage.setStreamer({ uid, roomId: 142, uname: 'Test UP', liveStatus: 0, liveTime: 0 });
    for (const group of groups) storage.subscribeGroup(group, uid);
    for (const user of users) storage.subscribeUser(user, uid);
}
async function pollLive() {
    const monitor = new LiveMonitorService(ctx);
    monitors.push(monitor);
    monitor.start();
    await monitor.checkAllStreamers();
    return monitor;
}
async function checkDynamic(monitor) {
    await monitor.checkStreamerDynamic(uid);
    await createNotificationService(ctx).flush();
}

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-regression-'));
    sent = []; delivered = []; requests = []; monitors = [];
    sendAction = undefined; fetchAction = undefined; liveStatus = 1;
    pages = { '': { items: [] } };
    const logger = Object.fromEntries(['log', 'debug', 'info', 'warn', 'error'].map(name => [name, () => {}]));
    ctx = {
        pluginName: 'bilibili-test', dataPath: path.join(directory, 'data'), configPath: path.join(directory, 'config.json'),
        adapterName: 'test', pluginManager: { config: {} }, logger,
        actions: { call: async (action, params) => {
            if (action === 'get_login_info') return { user_id: 10000 };
            assert.equal(action, 'send_msg');
            const copy = structuredClone(params);
            sent.push(copy);
            if (sendAction) await sendAction(copy);
            delivered.push(copy);
            return { message_id: delivered.length };
        } },
    };
    globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        requests.push({ url, options });
        if (fetchAction) return fetchAction(url, options);
        if (url.hostname === 'api.live.bilibili.com') return response({ [uid]: room() });
        return response(pages[url.searchParams.get('offset') || '']);
    };
    clearNotificationService();
    pluginState.init(ctx);
    pluginState.updateConfig({ renderDynamicCard: false });
});

afterEach(async () => {
    mock.restoreAll();
    for (const monitor of monitors) await monitor.stop();
    clearNotificationService();
    pluginState.cleanup();
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
});

test('global and group disable prevent commands and polling; enabling resumes both', async () => {
    seed();
    pluginState.updateConfig({ enabled: false });
    await handleMessage(ctx, groupEvent('#blive add 99'));
    const live = await pollLive();
    assert.deepEqual(sent, []);
    assert.deepEqual(requests, []);
    pluginState.updateConfig({ enabled: true, groupConfigs: { '100': { enabled: false } } });
    await handleMessage(ctx, groupEvent('#blive list'));
    await live.checkAllStreamers();
    assert.deepEqual(sent, []);
    assert.deepEqual(requests, []);
    pluginState.updateGroupConfig('100', { enabled: true });
    await live.checkAllStreamers();
    assert.match(text(delivered[0]), /开播提醒/);
});

test('configured prefix controls parsing and help; prefix lookalikes do not match', async () => {
    pluginState.updateConfig({ commandPrefix: '  #custom  ' });
    await handleMessage(ctx, groupEvent('#blive help'));
    await handleMessage(ctx, groupEvent('#customhelp'));
    assert.deepEqual(sent, []);
    await handleMessage(ctx, groupEvent('#custom help'));
    assert.match(text(sent[0]), /#custom 订阅/);
    assert.doesNotMatch(text(sent[0]), /#blive/);
    pluginState.updateConfig({ commandPrefix: '   ' });
    await handleMessage(ctx, groupEvent('#blive help'));
    assert.match(text(sent[1]), /#blive 订阅/);
});

test('non-admin subscription performs no API request or persistence', async () => {
    await handleMessage(ctx, groupEvent('#blive add 42', 'member'));
    assert.match(text(sent[0]), /只有群主或管理员/);
    assert.deepEqual(requests, []);
    assert.equal(storage.getStreamer(uid), undefined);
    assert.equal(fs.existsSync(path.join(ctx.dataPath, 'streamers.json')), false);
    assert.equal(storage.getGroupSub('100'), undefined);
});

test('unsafe UID is rejected, superuser can subscribe, private subscriptions remain isolated', async () => {
    await handleMessage(ctx, groupEvent('#blive add 9007199254740993'));
    assert.deepEqual(requests, []);
    pluginState.updateConfig({ superusers: '200，201' });
    await handleMessage(ctx, groupEvent('#blive add UID:42', 'member'));
    assert.deepEqual(storage.getGroupSub('100').streamerUids, [uid]);
    await handleMessage(ctx, { post_type: 'message', message_type: 'private', user_id: 201, raw_message: '#blive add 42' });
    assert.deepEqual(storage.getUserSub('201').streamerUids, [uid]);
    assert.equal(storage.getUserSub('202'), undefined);
});

test('live failure is retried only for failed recipients, including after restart', async () => {
    seed(['100', '101'], ['200']);
    storage.setGroupAtAll('100', true);
    sendAction = async params => { if (params.group_id === '101') throw new Error('offline'); };
    const monitor = await pollLive();
    assert.deepEqual(delivered.map(params => params.group_id || params.user_id), ['100', '200']);
    assert.deepEqual(Object.values(queue())[0].targets, ['group:101']);
    assert.ok(delivered[0].message.some(segment => segment.type === 'at'));
    await monitor.stop();
    monitors = [];
    clearNotificationService();
    pluginState.cleanup();
    pluginState.init(ctx);
    sendAction = undefined;
    await pollLive();
    assert.deepEqual(delivered.map(params => params.group_id || params.user_id), ['100', '200', '101']);
    assert.deepEqual(queue(), {});
});

test('subscribing while already live sends one catch-up to the new group only', async () => {
    seed(['100']);
    const monitor = await pollLive();
    assert.equal(delivered.filter(params => params.group_id === '100').length, 1);

    await handleMessage(ctx, groupEvent('#blive 订阅 UID:42', 'admin', 101));
    await createNotificationService(ctx).flush();

    const catchUps = () => delivered.filter(params => params.group_id === '101' && /开播提醒/.test(text(params)));
    assert.equal(catchUps().length, 1);
    assert.match(text(catchUps()[0]), /Test UP 开播啦/);

    await monitor.checkAllStreamers();
    assert.equal(catchUps().length, 1);
    assert.equal(delivered.filter(params => params.group_id === '100' && /开播提醒/.test(text(params))).length, 1);
});

test('live cache is dropped after the last unsubscribe and rebuilt on re-subscribe', async () => {
    seed(['100']);
    const monitor = await pollLive();
    const cacheFile = () => pluginState.loadDataFile('live_cache.json', {});
    assert.equal(cacheFile()[uid].lastLiveStatus, 1);

    await handleMessage(ctx, groupEvent('#blive 删除 UID:42'));
    await monitor.checkAllStreamers();
    assert.equal(cacheFile()[uid], undefined);

    await handleMessage(ctx, groupEvent('#blive 订阅 UID:42'));
    await createNotificationService(ctx).flush();
    const starts = () => delivered.filter(params => params.group_id === '100' && /开播提醒/.test(text(params)));
    assert.equal(starts().length, 1);

    await monitor.checkAllStreamers();
    assert.equal(starts().length, 2);
});

test('a failing recipient does not receive later events before the earlier event succeeds', async () => {
    seed(['100', '101']);
    const notifier = createNotificationService(ctx);
    notifier.enqueue('first', uid, { text: 'first' }, false);
    notifier.enqueue('second', uid, { text: 'second' }, false);
    sendAction = async params => { if (params.group_id === '100') throw new Error('offline'); };
    await notifier.flush();
    assert.deepEqual(delivered.map(text), ['first', 'second']);
    assert.deepEqual(sent.filter(params => params.group_id === '100').map(text), ['first']);
    sendAction = undefined;
    await new Promise(resolve => setTimeout(resolve, 1100));
    await notifier.flush();
    assert.deepEqual(delivered.filter(params => params.group_id === '100').map(text), ['first', 'second']);
});

test('paused queued recipients resume, unsubscribed recipients are removed', async () => {
    seed(['100', '101']);
    const notifier = createNotificationService(ctx);
    notifier.enqueue('pending', uid, { text: 'pending' }, false);
    pluginState.updateGroupConfig('100', { enabled: false });
    storage.unsubscribeGroup('101', uid);
    await notifier.flush();
    assert.deepEqual(sent, []);
    assert.deepEqual(Object.values(queue())[0].targets, ['group:100']);
    pluginState.updateGroupConfig('100', { enabled: true });
    await notifier.flush();
    assert.deepEqual(delivered.map(params => params.group_id), ['100']);
    assert.deepEqual(queue(), {});
});

test('overlapping live polls share work and send one start notification', async () => {
    seed();
    let release, reached;
    const ready = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fetchAction = async () => { reached(); await gate; return response({ [uid]: room() }); };
    const monitor = new LiveMonitorService(ctx);
    monitors.push(monitor);
    monitor.start();
    await ready;
    const first = monitor.checkAllStreamers();
    const second = monitor.checkAllStreamers();
    assert.equal(first, second);
    release();
    await Promise.all([first, second]);
    assert.equal(requests.length, 1);
    assert.deepEqual(delivered.map(text).map(value => value.includes('开播提醒')), [true]);
});

test('stop aborts an in-flight request and prevents post-stop notification', async () => {
    seed();
    let reached, requestSignal;
    const ready = new Promise(resolve => { reached = resolve; });
    fetchAction = (_url, { signal }) => new Promise((_resolve, reject) => {
        requestSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        reached();
    });
    const monitor = new LiveMonitorService(ctx);
    monitors.push(monitor);
    monitor.start();
    await ready;
    await monitor.stop();
    assert.equal(requestSignal.aborted, true);
    assert.equal(monitor.getStatus(), false);
    assert.deepEqual(sent, []);
});

test('stop waits for an already dispatched OneBot action before completing', async () => {
    seed();
    let release, reached;
    const ready = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    sendAction = async () => { reached(); await gate; };
    const monitor = new LiveMonitorService(ctx);
    monitors.push(monitor);
    monitor.start();
    await ready;
    let stopped = false;
    const stopping = monitor.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(queue(), {});
});

test('unseen items at or before the known boundary are recorded without pushing', async () => {
    seed();
    storage.setGroupAtAll('100', true);
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    pages[''] = { items: [dynamic('old', 100)] };
    await checkDynamic(monitor);
    assert.deepEqual(sent, []);
    pages[''] = { items: [dynamic('same-second', 100), dynamic('delayed', 50), dynamic('old', 100)] };
    await checkDynamic(monitor);
    assert.deepEqual(delivered, []);
    await checkDynamic(monitor);
    assert.deepEqual(delivered, []);
});

test('dynamic backlog is paginated until an entirely known page, keeping oldest-first order', async () => {
    seed();
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    pages[''] = { items: [dynamic('old-a', 1), dynamic('old-b', 2)], has_more: true, offset: 'p2' };
    await checkDynamic(monitor);
    requests.length = 0;
    pages = {
        '': { items: [dynamic('new-3', 5)], has_more: true, offset: 'p2' },
        p2: { items: [dynamic('new-2', 4), dynamic('new-1', 3)], has_more: true, offset: 'p3' },
        p3: { items: [dynamic('old-b', 2), dynamic('old-a', 1)], has_more: true, offset: 'p4' },
    };
    await checkDynamic(monitor);
    assert.deepEqual(requests.map(request => request.url.searchParams.get('offset') || ''), ['', 'p2', 'p3']);
    assert.deepEqual(delivered.map(text).map(value => value.match(/content (\S+)/)[1]), ['new-1', 'new-2', 'new-3']);
});

test('a new post does not drag older pagination pages into the push', async () => {
    seed();
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    pages = {
        '': { items: [dynamic('old-a', 100), dynamic('old-b', 90)], has_more: true, offset: 'p2' },
        p2: { items: [dynamic('old-c', 80), dynamic('old-d', 70)], has_more: false },
    };
    await checkDynamic(monitor);
    assert.deepEqual(sent, []);

    pages = {
        '': { items: [dynamic('fresh', 200), dynamic('old-a', 100), dynamic('old-b', 90)], has_more: true, offset: 'p2' },
        p2: { items: [dynamic('old-c', 80), dynamic('old-d', 70)], has_more: false },
    };
    await checkDynamic(monitor);
    assert.deepEqual(delivered.map(text).map(value => value.match(/content (\S+)/)[1]), ['fresh']);
});

test('dynamic push renders one card image preceded by a short header', async () => {
    seed();
    storage.setStreamer({ ...storage.getStreamer(uid), uname: '旧名字' });
    pluginState.updateConfig({ renderDynamicCard: true, gotenbergUrl: 'http://gotenberg.test', cardWidth: 600 });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    fetchAction = async url => {
        if (url.hostname === 'gotenberg.test') {
            return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return response(pages[url.searchParams.get('offset') || '']);
    };
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    await checkDynamic(monitor);
    pages[''] = { items: [dynamic('card-1', Math.floor(Date.now() / 1000) + 1)] };
    await checkDynamic(monitor);

    assert.equal(delivered.length, 1);
    assert.equal(text(delivered[0]), 'Test UP 发布了新文字动态！');
    assert.deepEqual(delivered[0].message.map(segment => segment.type), ['text', 'image']);
    assert.match(delivered[0].message[1].data.file, /^base64:\/\//);
    assert.equal(requests.filter(request => request.url.hostname === 'gotenberg.test').length, 1);
});

test('card rendering failure falls back to the full text notification', async () => {
    seed();
    pluginState.updateConfig({ renderDynamicCard: true, gotenbergUrl: 'http://gotenberg.test' });
    fetchAction = async url => {
        if (url.hostname === 'gotenberg.test') return new Response('boom', { status: 500 });
        return response(pages[url.searchParams.get('offset') || '']);
    };
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    await checkDynamic(monitor);
    pages[''] = { items: [dynamic('fallback-1', Math.floor(Date.now() / 1000) + 1)] };
    await checkDynamic(monitor);

    assert.equal(delivered.length, 1);
    assert.match(text(delivered[0]), /content fallback-1/);
    assert.match(text(delivered[0]), /发布了新文字动态/);
});

test('empty initial dynamic feed establishes a baseline and later posts are delivered', async () => {
    seed();
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    await checkDynamic(monitor);
    pages[''] = { items: [dynamic('first', Math.floor(Date.now() / 1000) + 1)] };
    await checkDynamic(monitor);
    assert.match(text(delivered[0]), /content first/);
});

test('dynamic API failures do not advance the baseline; live cards remain suppressed', async () => {
    seed();
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    pages[''] = { items: [dynamic('old')] };
    await checkDynamic(monitor);
    fetchAction = async () => ({ ok: false, status: 503 });
    await assert.rejects(monitor.checkStreamerDynamic(uid), /HTTP 503/);
    fetchAction = undefined;
    pages[''] = { items: [dynamic('new', 200), dynamic('live', 201, 'DYNAMIC_TYPE_LIVE_RCMD'), dynamic('old', 100)] };
    await checkDynamic(monitor);
    assert.deepEqual(delivered.map(text).map(value => value.match(/content (\S+)/)[1]), ['new']);
});

test('expired notification queue entries are pruned on load', () => {
    pluginState.saveDataFile('notification_queue.json', {
        stale: {
            uid,
            message: { text: 'stale' },
            atAll: false,
            targets: ['group:100'],
            createdAt: Date.now() - 25 * 60 * 60 * 1000,
        },
    });
    clearNotificationService();
    createNotificationService(ctx);
    assert.deepEqual(queue(), {});
});

test('malformed and unsupported dynamics are skipped without aborting the round', async () => {
    seed();
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    await checkDynamic(monitor);

    const future = Math.floor(Date.now() / 1000) + 1;
    pages[''] = {
        items: [
            { id_str: 'broken', type: 'DYNAMIC_TYPE_WORD', modules: [] },
            dynamic('pgc', future, 'DYNAMIC_TYPE_PGC'),
            dynamic('good', future + 1),
        ],
    };
    await checkDynamic(monitor);
    assert.deepEqual(delivered.map(text).map(value => value.match(/content (\S+)/)?.[1] ?? text(value)),
        ['good']);
});

test('live status batch requests are split into bounded chunks', async () => {
    requests.length = 0;
    const uids = Array.from({ length: 120 }, (_, index) => index + 1);
    await getLiveRoomStatusBatch(uids);
    assert.deepEqual(
        requests.map(request => request.url.searchParams.getAll('uids[]').length),
        [50, 50, 20],
    );
});

test('unchanged live status does not rewrite streamers.json', async () => {
    seed();
    const monitor = await pollLive();
    const file = path.join(ctx.dataPath, 'streamers.json');
    const before = fs.readFileSync(file, 'utf8');
    await monitor.checkAllStreamers();
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('per-group subscription cap blocks new streamers', async () => {
    seed(['100']);
    for (let index = 1; index <= 49; index += 1) {
        const streamerUid = 1000 + index;
        storage.setStreamer({ uid: streamerUid, roomId: streamerUid, uname: `UP${index}`, liveStatus: 0, liveTime: 0 });
        storage.subscribeGroup('100', streamerUid);
    }
    storage.setStreamer({ uid: 2000, roomId: 2000, uname: 'Overflow', liveStatus: 0, liveTime: 0 });
    assert.equal(storage.getGroupSub('100').streamerUids.length, 50);

    await handleMessage(ctx, groupEvent('#blive 订阅 UID:2000'));
    assert.match(text(sent.at(-1)), /上限/);
    assert.equal(storage.getGroupSub('100').streamerUids.includes(2000), false);
});

test('subscribe commands are rate limited per conversation', async () => {
    seed(['100']);
    storage.setStreamer({ uid: 43, roomId: 143, uname: 'UP43', liveStatus: 0, liveTime: 0 });
    await handleMessage(ctx, groupEvent('#blive 订阅 UID:43'));
    assert.match(text(sent.at(-1)), /群订阅成功/);
    await handleMessage(ctx, groupEvent('#blive 订阅 UID:42'));
    assert.match(text(sent.at(-1)), /操作过于频繁/);
});

test('long subscription lists are split across messages', async () => {
    seed(['100']);
    for (let index = 1; index <= 49; index += 1) {
        const streamerUid = 1000 + index;
        storage.setStreamer({
            uid: streamerUid, roomId: streamerUid,
            uname: '很长的测试主播名称'.repeat(6), liveStatus: 0, liveTime: 0,
        });
        storage.subscribeGroup('100', streamerUid);
    }
    await handleMessage(ctx, groupEvent('#blive 列表'));
    assert.ok(sent.length > 1);
    for (const params of sent) assert.ok(text(params).length <= 3000);
});

test('invalid repeated pagination cursor fails rather than silently skipping backlog', async () => {
    pages = {
        '': { items: [dynamic('a')], has_more: true, offset: 'repeat' },
        repeat: { items: [dynamic('b')], has_more: true, offset: 'repeat' },
    };
    await assert.rejects(getUserDynamics(uid, new Set(['old'])), /分页游标未推进/);
});

test('failed JSON replacement preserves disk contents and rolls back subscription state', async () => {
    seed();
    const file = path.join(ctx.dataPath, 'group_subs.json');
    const previous = fs.readFileSync(file, 'utf8');
    fs.mkdirSync(file + '.tmp');
    await handleMessage(ctx, groupEvent('#blive remove 42'));
    fs.rmdirSync(file + '.tmp');
    assert.deepEqual(storage.getGroupSub('100').streamerUids, [uid]);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
    assert.match(text(sent[0]), /操作失败/);
    assert.equal(storage.getStreamerSubscribedGroups(uid)[0].groupId, '100');
});

test('failed configuration change rejects and leaves the active configuration unchanged', async () => {
    fs.mkdirSync(ctx.configPath + '.tmp');
    try {
        await assert.rejects(plugin_on_config_change(ctx, undefined, 'enabled', false, pluginState.config));
    } finally {
        fs.rmdirSync(ctx.configPath + '.tmp');
    }
    assert.equal(pluginState.config.enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')).enabled, true);
});

test('stalled Bilibili requests time out instead of holding a poll indefinitely', { timeout: 15000 }, async () => {
    const keepAlive = setInterval(() => {}, 20000);
    fetchAction = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    try {
        await assert.rejects(getLiveRoomStatusBatch([uid]), error => error.name === 'TimeoutError');
    } finally {
        clearInterval(keepAlive);
    }
});
