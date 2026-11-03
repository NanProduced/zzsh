import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("invalid explicit baseline arguments fail before config or database access", async () => {
  const source = transpileModule(readFileSync(resolve('src/database/migrate-business-cli.ts'), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText.replace('void main().catch', 'globalThis.result = main().catch');
  for (const args of [['--initial', '--baseline'], ['--initial', '--baseline='], ['--initial', '--baseline', '--other'], ['--baseline', 'release_0151']]) {
    let configReads = 0; const errors: string[] = [];
    class ConfigurationError extends Error {}
    const context: any = { exports: {}, process: { argv: ['node', 'cli', ...args], exitCode: 0 }, console: { error: (error: string) => errors.push(error) },
      require: (name: string) => name.includes('config/config') ? { ConfigurationError, loadConfig: () => { configReads++; throw new Error('CONFIG_REACHED'); } }
        : name === './business-migrations' ? { BusinessMigrationHistoryError: class extends Error {} } : {} };
    runInNewContext(source, context); await context.result;
    assert.equal(configReads, 0, args.join(' ')); assert.equal(context.process.exitCode, 1); assert.match(errors[0]!, /configuration rejected/);
  }
});

test("existing CLI defaults and both explicit baseline forms reach the same migration entry", async () => {
  const source = transpileModule(readFileSync(resolve('src/database/migrate-business-cli.ts'), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText.replace('void main().catch', 'globalThis.result = main().catch');
  for (const args of [[], ['--initial'], ['--initial', '--baseline', 'release_0151'], ['--initial', '--baseline=release_0151']]) {
    let options: any, closed = false;
    const pool = { end: async () => { closed = true; } };
    const context: any = { exports: {}, process: { argv: ['node', 'cli', ...args], exitCode: 0 }, console,
      require: (name: string) => name.includes('config/config') ? { ConfigurationError: class extends Error {}, loadConfig: () => ({ profile:'migration',database:{runtimeUser:'runtime'} }) }
        : name === './business' ? { createBusinessPool: () => pool, assertBusinessMigrationIdentity: async () => {} }
          : { runBusinessMigrations: async (_pool: unknown, input: unknown) => { assert.equal(_pool,pool); options=input; }, BusinessMigrationHistoryError: class extends Error {} } };
    runInNewContext(source, context); await context.result;
    assert.equal(options.runtimeUser,'runtime'); assert.equal(options.initialInstall,args.includes('--initial'));
    assert.equal(options.initialBaseline,args.some(arg=>arg.startsWith('--baseline'))?'release_0151':undefined);
    assert.equal(closed,true); assert.equal(context.process.exitCode,0);
  }
});
