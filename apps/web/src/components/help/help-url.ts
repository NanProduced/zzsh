/** 帮助搜索的 URL 工具：清空时去掉 q 参数、保留其余视图参数 */
export function stripHelpSearchQuery(currentUrl: string): string | null {
  const url = new URL(currentUrl, "http://help.local");
  if (!url.searchParams.has("q")) return null;
  url.searchParams.delete("q");
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}
