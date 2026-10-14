# Noto Sans SC shared source

One canonical source for the user site and Admin. 101 unmodified variable WOFF2 subsets; wght 100–900, font-display swap and upstream unicode-range are preserved in fonts.css.

Source and per-file hashes: manifest.json. License: LICENSE-NotoSansSC.txt (SIL OFL 1.1). Each app may bundle its own deployment copy. Do not hand-maintain a second source directory or preload all subsets. App-specific typography and system fallback remain in the app.

The Web imports fonts.css through src/app/noto-sans-sc.css. Admin adoption follows in its integration package; its active worktree is not rewritten by this package. Rare CJK characters outside these subsets require the existing system-font fallback.

The Web public/fonts/noto-sans-sc/LICENSE-NotoSansSC.txt is the distribution notice copied from this canonical license; keep it byte-identical when updating. Font binaries are only maintained here.
