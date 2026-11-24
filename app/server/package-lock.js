import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
class PackageLock {
  context = new AsyncLocalStorage();
  queue = [];
  readers = 0;
  writer = false;
  withReadLock(fn) {
    return this.run("read", fn);
  }
  withWriteLock(fn) {
    return this.run("write", fn);
  }
  async run(mode, fn) {
    const held = this.context.getStore();
    if (held?.active) {
      if (held.mode === "read" && mode === "write") throw new Error("不能在模块读锁内升级为写锁。");
      return fn();
    }
    await new Promise((start) => {
      this.queue.push({ mode, start });
      this.drain();
    });
    const lease = { mode, active: true };
    try {
      return await this.context.run(lease, fn);
    } finally {
      lease.active = false;
      if (mode === "write") this.writer = false;
      else this.readers -= 1;
      this.drain();
    }
  }
  drain() {
    if (this.writer) return;
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.mode === "write") {
        if (this.readers) return;
        this.writer = true;
        this.queue.shift().start();
        return;
      }
      this.readers += 1;
      this.queue.shift().start();
    }
  }
}
const locks = /* @__PURE__ */ new Map();
function packageLockFor(dataDir) {
  const key = resolve(dataDir);
  let lock = locks.get(key);
  if (!lock) {
    lock = new PackageLock();
    locks.set(key, lock);
  }
  return lock;
}
export {
  PackageLock,
  packageLockFor
};
