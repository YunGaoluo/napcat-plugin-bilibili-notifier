import { resolve, dirname } from 'path';
import { defineConfig, loadEnv } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

/** 生成部署所需元信息；生成失败必须使构建失败。 */
function copyAssetsPlugin() {
    return {
        name: 'copy-assets',
        writeBundle() {
            const pkg = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
            const distPkg = {
                name: pkg.name,
                plugin: pkg.plugin,
                version: pkg.version,
                type: pkg.type,
                main: pkg.main,
                description: pkg.description,
                author: pkg.author,
                napcat: pkg.napcat,
            };
            fs.writeFileSync(resolve(__dirname, 'dist/package.json'), JSON.stringify(distPkg, null, 2));
            console.log('[copy-assets] 已生成插件 package.json');
        },
    };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, __dirname, '');
    return {
        resolve: {
            conditions: ['node', 'default'],
        },
        build: {
            sourcemap: false,
            target: 'esnext',
            minify: false,
            lib: {
                entry: resolve(__dirname, 'src/index.ts'),
                formats: ['es'],
                fileName: () => 'index.mjs',
            },
            rollupOptions: {
                external: [...nodeModules],
                output: {
                    inlineDynamicImports: true,
                },
            },
            outDir: 'dist',
        },
        plugins: [
            nodeResolve(),
            {
                name: 'fix-dirname',
                transform(code, id) {
                    if (id.includes('node-cron')) {
                        return code.replace(/__dirname/g, 'process.cwd()');
                    }
                    return code;
                }
            },
            copyAssetsPlugin(),
            napcatHmrPlugin({
                enabled: mode === 'deploy',
                wsUrl: env.NAPCAT_DEBUG_WS || 'ws://127.0.0.1:8998',
                token: env.NAPCAT_DEBUG_TOKEN || undefined,
            })
        ],
    };
});
