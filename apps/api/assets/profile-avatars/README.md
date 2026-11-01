# 默认头像资源

Owner 提供的四张原图只作来源追溯，不随应用公开，也不通过头像读取接口返回。这里提交的是 256×256 方形 WebP 衍生图；`manifest.json` 记录 `presetId`、版本、`storageKey`/SHA、MIME、尺寸、字节数和原图 SHA。

| presetId | 衍生图 SHA256 | 原图 SHA256 |
|---|---|---|
| avatar-strike | `ba84c8b6fe5d50fe6420d2cc82bc29d0d4d2bb354e43985b057e9d3abd7d9b5e` | `7a00f7366ada819c09b5112f06bab7a42f9f99880b8f64201caa79ffae3e18a4` |
| avatar-night | `729e1d422f3ade04ae135751fe7e7209e99d3323331fbf2a69e6cd2ce86d7a3c` | `7099e06d7463e29b3d5a68c60db6c30cf49eab3e989d3fcd578c9e56a7704a0b` |
| avatar-frost | `76af969bba98b6bbcf6212abfc7fa9e581c314636fe9180d0c564888466125a3` | `ac807b3065c904f789c87ba931e5fc4f5af790e6afcadd712fbde3318606f107` |
| avatar-aurora | `bb22975e2a6c9fd3c83649ddc73fa52255a3b52bf1d3c018e1a23e6f6af3aaa0` | `7d7dded5216d2bf9dfad739766e43e2d12fe475f2498773811d33b89b154ccd5` |

生成为 `sharp().rotate().resize(256, 256, { fit: "cover", position: "attention" }).webp({ quality: 82, effort: 6 })`，不带 EXIF。清单和文件变更必须同时更新 `apps/api/src/profile/profile-avatar-presets.ts`，测试会核对字节 SHA 和尺寸。

初始化对象使用 `npm run profile:avatar-presets -w @zzsh/api -- upload`；只读核验使用 `-- check`。未初始化时不得称头像已上线。
