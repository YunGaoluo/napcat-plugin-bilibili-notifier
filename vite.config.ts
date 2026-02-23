import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

/**
 * 构建后自动复制资源的 Vite 插件
 * - 复制 webui 构建产物到 dist/webui
 * - 生成精简的 package.json（只保留运行时必要字段）
 * - 复制 templates 目录（如果存在）
 */
function copyAssetsPlugin() {
    return {
        name: 'copy-assets',
        writeBundle() {
            try {
                const distDir = resolve(__dirname, 'dist');

                // 3. 生成精简的 package.json（只保留运行时必要字段）
                const pkgPath = resolve(__dirname, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    const distPkg: Record<string, unknown> = {
                        name: pkg.name,
                        plugin: pkg.plugin,
                        version: pkg.version,
                        type: pkg.type,
                        main: pkg.main,
                        description: pkg.description,
                        author: pkg.author,
                        dependencies: pkg.dependencies,
                    };
                    if (pkg.napcat) {
                        distPkg.napcat = pkg.napcat;
                    }
                    fs.writeFileSync(
                        resolve(distDir, 'package.json'),
                        JSON.stringify(distPkg, null, 2)
                    );
                    console.log('[copy-assets] (o\'v\'o) 已生成精简 package.json');
                }

                console.log('[copy-assets] (*\'v\'*) 资源复制完成！');
            } catch (error) {
                console.error('[copy-assets] (;_;) 资源复制失败:', error);
            }
        },
    };
}

export default defineConfig({
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
            wsUrl: 'ws://192.168.5.4:8998'
        })
    ],
});
