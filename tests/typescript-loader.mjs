import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (error) {
        if (!extname(specifier) && (specifier.startsWith('.') || specifier.startsWith('napcat-types/'))) {
            try { return await nextResolve(specifier + '.ts', context); } catch {
                return nextResolve(specifier + '/index.ts', context);
            }
        }
        throw error;
    }
}

export async function load(url, context, nextLoad) {
    if (url.endsWith('.ts')) {
        const source = await readFile(new URL(url), 'utf8');
        return {
            format: 'module', shortCircuit: true,
            source: ts.transpileModule(source, {
                compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
            }).outputText,
        };
    }
    return nextLoad(url, context);
}
