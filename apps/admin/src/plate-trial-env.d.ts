declare global {
  // Injected by vite define from VITE_PLATE_TRIAL_ENABLED; undefined in offline test harness.
  var __PLATE_TRIAL_ENABLED__: boolean | undefined;
}

export {};