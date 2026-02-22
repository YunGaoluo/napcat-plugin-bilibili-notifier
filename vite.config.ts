import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import { copyFileSync } from 'fs';

// @ts-ignore
const __dirname = dirname(fileURLToPath(import.meta.url));

const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

// 自定义插件用于复制 package.json
const copyPackageJson = () => ({
    name: 'copy-package-json',
    closeBundle() {
        const src = resolve(__dirname, 'package.json');
        const dest = resolve(__dirname, 'dist/package.json');
        copyFileSync(src, dest);
        console.log('✅ package.json copied to dist/');
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
        copyPackageJson()
    ],
});
