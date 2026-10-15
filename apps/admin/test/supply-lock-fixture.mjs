// Only the offline component harness uses this LockManager. Real browsers use Web Locks.
export function installSupplyLockFixture(browser, held = new Set()) {
  Object.defineProperty(browser.navigator, 'locks', { configurable: true, value: {
    async request(name, options, task) {
      if (options.ifAvailable !== true || options.mode !== 'exclusive') throw new Error('Unexpected lock contract');
      if (held.has(name)) return task(null);
      held.add(name);
      try { return await task({name, mode:'exclusive'}); }
      finally { held.delete(name); }
    },
  }});
  return held;
}
