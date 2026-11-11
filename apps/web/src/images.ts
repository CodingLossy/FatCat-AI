// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// Web 上传图片前的处理(ADR 0020 第 5 节):长边缩到 2048 px 以内并重新编码,顺带去掉 EXIF(含 GPS)。
import {
    ATTACHMENT_MEDIA_TYPES,
    type AttachmentMediaType,
    MAX_ATTACHMENT_BYTES,
    type ModelProfile,
    type Session,
    type Settings,
} from '@fatcat-ai/shared';

export const MAX_IMAGE_EDGE = 2048;
const JPEG_QUALITY = 0.9;

/** 等比缩放到长边不超过 max;已经够小时原样返回。 */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
    const edge = Math.max(width, height);
    if (edge <= max) return { width, height };
    const scale = max / edge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function isAcceptedType(type: string): type is AttachmentMediaType {
    return (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(type);
}

/** 选文件时的预检;服务器按魔数再检查一遍。 */
export function precheck(file: File): 'ok' | 'type' | 'size' {
    // 有的系统给不出类型:交给服务器按魔数判断
    if (file.type !== '' && !isAcceptedType(file.type)) return 'type';
    // GIF 原样上传,不能靠重新编码变小
    if (file.type === 'image/gif' && file.size > MAX_ATTACHMENT_BYTES) return 'size';
    return 'ok';
}

/**
 * 重新编码:PNG 保持 PNG,其余转为 JPEG(WebP 在部分浏览器的 Canvas 中不能输出);GIF 原样返回(会丢掉动画)。
 * 浏览器解码失败时原样返回,由服务器决定接受与否。
 */
export async function prepareImage(file: File): Promise<Blob> {
    if (file.type === 'image/gif') return file;
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        return file;
    }
    try {
        const { width, height } = fitWithin(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, width, height);
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
        return blob ?? file;
    } finally {
        bitmap.close();
    }
}

/** 与服务器选择配置档的顺序一致(ADR 0006):会话设置 > 默认 chat 配置档 > 第一个 chat 配置档。 */
export function effectiveProfile(
    profiles: readonly ModelProfile[],
    settings: Pick<Settings, 'defaultChatProfileId'> | null,
    session: Pick<Session, 'modelProfileId'> | null,
): ModelProfile | null {
    const byId = (id: string | null | undefined) => (id ? (profiles.find((p) => p.id === id) ?? null) : null);
    return (
        byId(session?.modelProfileId) ??
        byId(settings?.defaultChatProfileId) ??
        profiles.find((p) => p.purpose.includes('chat')) ??
        null
    );
}
