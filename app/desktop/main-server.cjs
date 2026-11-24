// Retired entry point: never load Electron or connect a browser shell to an
// execution server. Keep this stub so old launch commands fail explicitly.
console.error('desktop/main-server.cjs 已退役。请用 pnpm desktop 启动本地 App；云端仅用 pnpm registry 提供技能包与账号授权 API。');
process.exitCode = 1;
