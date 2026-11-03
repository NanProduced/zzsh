# release_0151

这是从空库安装canonical前152份后导出的新装基线，最后一份是 `0151_profile_avatar_policy`。四段按顺序执行：01最终结构、02必要静态种子、03约束索引触发器、04 PUBLIC权限。runtime窄权限仍由 `applyRuntimePrivileges` 安装。

默认 `--initial` 仍使用 registry 的 active。本基线完成真实等价验证并被维护者选为 active 之前，不会替换已安装的 release_0141。显式新装使用 `--initial --baseline release_0151`。

对象中文说明在SQL行注释和 `NAVIGATION.md`。数据库 `COMMENT` 只保留canonical已经写入的元数据。
