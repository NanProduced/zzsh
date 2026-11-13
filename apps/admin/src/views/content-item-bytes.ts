export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
export const byteLabel = (value: string, max: number) => `${utf8Bytes(value)} / ${max} 字节`;
