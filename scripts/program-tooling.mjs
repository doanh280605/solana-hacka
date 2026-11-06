import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './keys.mjs';
import { toolEnv } from './runtime.mjs';

export const platformToolsVersion = 'v1.56';

function checked(command, args, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}${capture ? `: ${result.stderr}` : ''}`);
  }
  return capture ? result.stdout.trim() : result;
}

// Link the installed host compiler into a project-local rustup home. The SBF
// builder may relink its `solana` toolchain here without changing global rustup.
export function programToolEnv() {
  const rustupHome = resolve(root, '.tools/rustup');
  const env = toolEnv({
    XDG_CACHE_HOME: resolve(root, '.tools/cache'),
    RUSTUP_HOME: rustupHome,
    RUSTUP_TOOLCHAIN: 'checkout-host',
  });
  mkdirSync(rustupHome, { recursive: true });
  if (!existsSync(resolve(rustupHome, 'toolchains/checkout-host'))) {
    const installedRustc = checked('rustup', ['which', '--toolchain', 'stable', 'rustc'], toolEnv(), true);
    checked('rustup', ['toolchain', 'link', 'checkout-host', dirname(dirname(installedRustc))], env);
  }
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? 'build';
    const env = programToolEnv();
    if (mode === 'host-tests') checked('cargo', ['test', '--workspace', '--locked'], env);
    else if (mode === 'build') {
      // Anchor 0.31.1 forwards trailing SBF flags into its IDL cargo test too.
      // Build separately so host IDL generation does not receive SBF flags.
      checked('anchor', ['build', '--no-idl', '--', '--tools-version', platformToolsVersion, '--', '-Zbuild-std=std,panic_abort', '--locked'], env);
      mkdirSync(resolve(root, 'target/idl'), { recursive: true });
      mkdirSync(resolve(root, 'target/types'), { recursive: true });
      checked('anchor', ['idl', 'build', '--out', resolve(root, 'target/idl/checkout.json'), '--out-ts', resolve(root, 'target/types/checkout.ts'), '--', '--locked'], env);
    }
    else if (mode === 'sbf') checked('cargo', ['build-sbf', '--tools-version', platformToolsVersion, '--', '-Zbuild-std=std,panic_abort', '--locked'], env);
    else if (mode === 'cargo') checked('cargo', process.argv.slice(3), env);
    else if (mode === 'msrv') {
      const metadata = JSON.parse(checked('cargo', ['metadata', '--format-version', '1', '--locked'], env, true));
      for (const p of metadata.packages) {
        if (p.edition === '2024' || Number((p.rust_version ?? '1.0').split('.')[1]) > 79) {
          console.log(`${p.name} ${p.version} edition=${p.edition} rust=${p.rust_version}`);
        }
      }
    }
    else throw new Error('Usage: npx tsx scripts/program-tooling.mjs [build|sbf|host-tests|cargo <args...>]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
