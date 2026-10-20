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

test('dynamic IDs handle equal timestamps and delayed visibility without @all or duplicates', async () => {
    seed();
    storage.setGroupAtAll('100', true);
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    pages[''] = { items: [dynamic('old', 100)] };
    await checkDynamic(monitor);
    assert.deepEqual(sent, []);
    pages[''] = { items: [dynamic('same-second', 100), dynamic('delayed', 50), dynamic('old', 100)] };
    await checkDynamic(monitor);
    assert.deepEqual(delivered.map(text).map(value => value.match(/content (\S+)/)[1]), ['delayed', 'same-second']);
    assert.equal(delivered.some(params => params.message.some(segment => segment.type === 'at')), false);
    await checkDynamic(monitor);
    assert.equal(delivered.length, 2);
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

test('empty initial dynamic feed establishes a baseline and later posts are delivered', async () => {
    seed();
    const monitor = new DynamicMonitorService(ctx);
    monitors.push(monitor);
    await checkDynamic(monitor);
    pages[''] = { items: [dynamic('first')] };
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
    pages[''] = { items: [dynamic('new'), dynamic('live', 101, 'DYNAMIC_TYPE_LIVE_RCMD'), dynamic('old')] };
    await checkDynamic(monitor);
    assert.deepEqual(delivered.map(text).map(value => value.match(/content (\S+)/)[1]), ['new']);
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
