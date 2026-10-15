# Noto Sans SC shared source

One canonical source for the user site and Admin. 101 unmodified variable WOFF2 subsets; wght 100–900, font-display swap and upstream unicode-range are preserved in fonts.css.

Source and per-file hashes: manifest.json. License: LICENSE-NotoSansSC.txt (SIL OFL 1.1). Each app may bundle its own deployment copy. Do not hand-maintain a second source directory or preload all subsets. App-specific typography and system fallback remain in the app.

The Web imports fonts.css through src/app/noto-sans-sc.css. Admin imports the same CSS from src/styles.css. Rare CJK characters outside these subsets require the existing system-font fallback.

Each app public/fonts/noto-sans-sc/LICENSE-NotoSansSC.txt is a distribution notice copied from this canonical license; keep both byte-identical when updating. Font binaries are only maintained here.

Upstream provenance: google/fonts commit `66928797f271fed5ee428544e7229685e2d90127`, `ofl/notosanssc/OFL.txt` (SHA256 `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`). The complete upstream license retains the Adobe 2014–2021 copyright and Reserved Font Name Source notice. The WOFF2 files are unmodified Google Fonts Web v41 subsets; only local filenames and CSS URLs differ. Source TTF version 2.004, SHA256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.

Coverage measured in the accepted source package: 13,635 mapped Unicode characters, including 12,242 basic CJK and 27 extension-A characters, with no extension-B characters. Rare names such as 䶮, 齾 and 𠮷 use the system fallback; glyph availability depends on installed fonts. These counts are inherited from the unchanged font bytes, not remeasured by this integration.
