import type { ContentSection } from './index';
export function inspectContentMarkdown(source: string, options?: import('./markdown.mjs').MarkdownOptions): Promise<import('./markdown.mjs').MarkdownInspection>;
export function convertContentDocument(document: { sections: readonly ContentSection[] }): ReturnType<typeof import('./markdown.mjs').convertLegacyDocument>;
