import { mkdir, readdir, symlink, lstat, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
export async function prepareNativeCompatibility({ workspace, ndkPath, minSdk, signal }) {
  const header = join(workspace, 'unityLibrary/src/main/Il2CppOutputProject/IL2CPP/external/baselib/Include/Internal/Compiler/CompilerEnvironmentClang.h');
  const source = await readFile(header, 'utf8').catch(() => '');
  // Only adapt exports whose Baselib explicitly requires C++17.
  if (!/C\+\+17|201703/.test(source)) return { fingerprintInputs: [] };
  const root = join(workspace, '.partner-agent', 'native-compat');
  const ndk = join(root, 'ndk');
  const chain = ['toolchains', 'llvm', 'prebuilt', 'darwin-x86_64', 'bin'];
  const api = Math.max(24, minSdk);
  const compiler = join(ndkPath, ...chain, 'clang++');
  const wrapper = `#!/bin/bash
set -e
args=()
is_c=0
compile=0
previous=''
for arg in "$@"; do
  if [[ "$previous" == '-x' && ( "$arg" == 'c' || "$arg" == 'c-header' ) ]]; then is_c=1; fi
  [[ "$arg" == *.c ]] && is_c=1
  [[ "$arg" == '-c' ]] && compile=1
  previous="$arg"
done
for arg in "$@"; do
  if [[ "$is_c" == 0 && "$arg" == -std=* ]]; then continue; fi
  if [[ "$compile" == 0 ]]; then
    case "$arg" in
      armv7a-linux-androideabi[0-9]*) arg="armv7a-linux-androideabi${api}" ;;
      aarch64-linux-android[0-9]*) arg="aarch64-linux-android${api}" ;;
    esac
  fi
  args+=("$arg")
done
[[ "$is_c" == 0 ]] && args+=('-std=c++17')
exec ${quote(compiler)} "\u0024{args[@]}"
`;
  async function mirror(src, dest, depth = 0) {
    signal?.throwIfAborted();
    await mkdir(dest, { recursive: true });
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const from = join(src, entry.name), to = join(dest, entry.name);
      if (depth < chain.length && entry.name === chain[depth]) await mirror(from, to, depth + 1);
      else if (depth === chain.length && entry.name === 'clang++') {
        const existing = await lstat(to).catch(() => null);
        if (existing?.isSymbolicLink()) throw new Error('兼容编译器路径不能是符号链接');
        if (await readFile(to, 'utf8').catch(() => '') !== wrapper) await writeFile(to, wrapper, { mode: 0o755 });
        await chmod(to, 0o755);
      } else if (!await lstat(to).catch(() => null)) await symlink(from, to);
    }
  }
  await mirror(ndkPath, ndk);
  return { ndkPath: ndk, fingerprintInputs: [join(ndk, ...chain, 'clang++')] };
}
export function patchNativeGradle(text, compatibility) {
  if (!compatibility.ndkPath) return text;
  const value = "'" + compatibility.ndkPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  // Leave other NDK declarations on the real SDK; only this legacy IL2CPP invocation is adapted.
  const expression = /commandLineArgs\.add\("--tool-chain-path="\s*\+\s*getProperty\("unity\.androidNdkPath"\)\)/g;
  text = text.replace(expression, 'commandLineArgs.add("--tool-chain-path=" + ' + value + ')');
  text = text.replace(/commandLineArgs\.add\("--tool-chain-path="\s*\+\s*'[^'\n]*\/\.partner-agent\/native-compat\/ndk'\)/g, 'commandLineArgs.add("--tool-chain-path=" + ' + value + ')');
  return text;
}
