import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

// @ts-ignore
const __dirname = dirname(fileURLToPath(import.meta.url));

const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

// 生成精简 package.json 的插件
const generateMinimalPackageJson = () => ({
    name: 'generate-minimal-package-json',
    closeBundle() {
        const pkgPath = resolve(__dirname, 'package.json');
        const distDir = resolve(__dirname, 'dist');

        // 确保 dist 目录存在
        if (!existsSync(distDir)) {
            mkdirSync(distDir, { recursive: true });
        }

        if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
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

            writeFileSync(
                resolve(distDir, 'package.json'),
                JSON.stringify(distPkg, null, 2)
            );

            console.log('[copy-assets] (o\'v\'o) 已生成精简 package.json');
        }
    }
});

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
        generateMinimalPackageJson()
    ],
});
