#!/usr/bin/env node
/**
 * 探测目标主机端口是否有服务响应。
 *
 * 用法:
 *   node scripts/check-service.mjs [host] [port] [--timeout=5000]
 *   node scripts/check-service.mjs 127.0.0.1 8998
 *
 * 依次执行: DNS 解析 -> TCP 连接 -> HTTP GET / -> WebSocket 握手。
 * 任一步失败都会打印原因，不会抛异常（退出码 1 表示端口不可用）。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const args = process.argv.slice(2);
const opts = args.filter((a) => a.startsWith('--'));
const pos = args.filter((a) => !a.startsWith('--'));
const host = pos[0] ?? '127.0.0.1';
const port = Number(pos[1] ?? 8998);
const timeoutMs = Number(opts.find((o) => o.startsWith('--timeout='))?.split('=')[1] ?? 5000);

const results = [];
function record(step, ok, detail) {
    results.push({ step, ok, detail });
    console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${step}: ${detail}`);
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

try {
    const { address, family } = await withTimeout(dns.lookup(host, { family: 4 }), timeoutMs, 'DNS');
    record('DNS', true, `${host} -> ${address} (IPv${family})`);

    try {
        await withTimeout(
            new Promise((resolve, reject) => {
                const socket = net.connect({ host: address, port });
                socket.once('connect', () => {
                    socket.destroy();
                    resolve();
                });
                socket.once('error', reject);
            }),
            timeoutMs,
            'TCP'
        );
        record('TCP', true, `${address}:${port} 可连接`);
    } catch (err) {
        record('TCP', false, `${address}:${port} ${err.code ?? err.message}`);
    }

    const tcpOk = results.at(-1).ok;
    if (!tcpOk) {
        console.log(`\n结论: ${host}:${port} 无法建立 TCP 连接，端口无可用服务（或被防火墙过滤）。`);
        process.exit(1);
    }

    // HTTP 探测
    try {
        const res = await withTimeout(
            fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(timeoutMs) }),
            timeoutMs,
            'HTTP'
        );
        const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
        record('HTTP', true, `HTTP ${res.status} ${res.statusText} | server=${res.headers.get('server') ?? '-'} | body="${body}"`);
    } catch (err) {
        record('HTTP', false, `GET / 无 HTTP 响应 (${err.cause?.code ?? err.name}: ${err.message})`);
    }

    // WebSocket 探测 (napcat-plugin-debug 默认 ws 服务)
    try {
        const { WebSocket } = await import('ws');
        const ws = new WebSocket(`ws://${host}:${port}/`);
        const outcome = await withTimeout(
            new Promise((resolve, reject) => {
                ws.once('open', () => resolve('open'));
                ws.once('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
                ws.once('error', reject);
            }),
            timeoutMs,
            'WS'
        );
        ws.terminate();
        record('WS', true, `WebSocket 握手: ${outcome}`);
    } catch (err) {
        record('WS', false, `WebSocket 握手失败 (${err.message})`);
    }

    const anyOk = results.some((r) => r.ok && r.step !== 'DNS');
    console.log(`\n结论: ${host}:${port} ${anyOk ? '有服务响应。' : '端口可连接但无协议响应。'}`);
    process.exit(anyOk ? 0 : 1);
} catch (err) {
    record('DNS', false, `${host} 解析失败 (${err.code ?? err.message})`);
    console.log(`\n结论: 域名无法解析，服务不可达。`);
    process.exit(1);
}
