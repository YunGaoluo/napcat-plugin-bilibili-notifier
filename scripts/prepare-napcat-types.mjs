import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 上游将声明源码发布为 .ts；生成 .d.ts 镜像供 tsc 使用，运行时仍使用原包。
// 不修改类型内容、不屏蔽业务诊断；语法损坏通过 pnpm 的受版本约束补丁修复。
const require = createRequire(import.meta.url);
const source = dirname(require.resolve('napcat-types/package.json'));
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../.napcat-types');

async function copyDeclarations(input, output) {
    await mkdir(output, { recursive: true });
    for (const entry of await readdir(input, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const from = join(input, entry.name);
        if (entry.isDirectory()) {
            await copyDeclarations(from, join(output, entry.name));
        } else if (entry.name.endsWith('.ts')) {
            const name = entry.name.endsWith('.d.ts') ? entry.name : entry.name.slice(0, -3) + '.d.ts';
            await writeFile(join(output, name), await readFile(from));
        }
    }
}

await rm(target, { recursive: true, force: true });
await copyDeclarations(source, target);
