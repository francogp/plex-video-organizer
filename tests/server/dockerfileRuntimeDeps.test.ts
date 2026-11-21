import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractPackageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('/')) {
    return null;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0] ?? null;
}

async function collectDirectRuntimePackages(roots: string[]): Promise<Set<string>> {
  const packages = new Set<string>();
  const importRegex = /(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g;
  const sideEffectImportRegex = /import\s+['"]([^'"]+)['"]/g;

  for (const root of roots) {
    const files = await collectTsFiles(root);
    for (const filePath of files) {
      const content = await fs.readFile(filePath, 'utf8');
      for (const regex of [importRegex, sideEffectImportRegex]) {
        for (const match of content.matchAll(regex)) {
          const specifier = match[1];
          if (!specifier) {
            continue;
          }
          const pkg = extractPackageName(specifier);
          if (pkg) {
            packages.add(pkg);
          }
        }
      }
    }
  }
  return packages;
}

async function expandTransitiveDependencies(directPackages: Set<string>): Promise<Set<string>> {
  const resolved = new Set<string>();
  const queue = [...directPackages];

  while (queue.length > 0) {
    const pkg = queue.shift();
    if (!pkg || resolved.has(pkg)) {
      continue;
    }
    resolved.add(pkg);

    const pkgJsonPath = path.join(REPO_ROOT, 'node_modules', pkg, 'package.json');
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(parsed.dependencies ?? {})) {
      if (!resolved.has(dep)) {
        queue.push(dep);
      }
    }
  }
  return resolved;
}

describe('Dockerfile runtime dependencies', () => {
  it('includes every direct and transitive npm package imported by src/server and src/domain', async () => {
    const directPackages = await collectDirectRuntimePackages([
      path.join(REPO_ROOT, 'src', 'server'),
      path.join(REPO_ROOT, 'src', 'domain')
    ]);
    const requiredPackages = await expandTransitiveDependencies(directPackages);

    const dockerfile = await fs.readFile(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const runtimeStageMatch = dockerfile.split(/FROM\s+\S+\s+AS\s+runtime/i)[1] ?? '';

    const copiesAllProdNodeModules =
      /COPY\s+--from=\S+\s+\/app\/node_modules\s+\.\/node_modules/.test(runtimeStageMatch) &&
      /npm\s+(?:prune\s+--omit=dev|ci\s+--omit=dev)/.test(dockerfile);

    if (copiesAllProdNodeModules) {
      expect(requiredPackages.size).toBeGreaterThan(0);
      return;
    }

    const copiedPackages = new Set<string>();
    const copyPkgRegex =
      /COPY\s+--from=\S+\s+\/app\/node_modules\/([^\s]+)\s+\.\/node_modules\/\1/g;
    for (const match of runtimeStageMatch.matchAll(copyPkgRegex)) {
      if (match[1]) {
        copiedPackages.add(match[1]);
      }
    }

    const missing = [...requiredPackages].filter((pkg) => !copiedPackages.has(pkg));
    expect(missing).toEqual([]);
  });
});
