// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 「文件」面板:文件树 + 预览,只渲染本会话里 fs.list / fs.read 已经送达的结果(ui-redesign.md 第 6 节)。
// 内容是不可信数据:一律按文本显示,不渲染成 HTML,前 500 行,「显示更多」只从已收到的内容里取。
import { useState } from 'react';
import { Icon } from './Icon.js';
import { useI18n } from './i18n.js';
import { languageOf, PREVIEW_MAX_LINES, type FileTreeNode, type FilesModel } from './workbench.js';

function Tree({
    nodes,
    selected,
    onSelect,
    hasPreview,
}: {
    nodes: FileTreeNode[];
    selected: string | null;
    onSelect: (path: string) => void;
    hasPreview: (path: string) => boolean;
}) {
    return (
        <ul className="file-tree">
            {nodes.map((node) => (
                <li key={node.path}>
                    {node.kind === 'file' && hasPreview(node.path) ? (
                        <button
                            type="button"
                            className={`tree-row${node.path === selected ? ' active' : ''}`}
                            onClick={() => onSelect(node.path)}
                        >
                            <Icon name="file" size={16} />
                            <span>{node.name}</span>
                        </button>
                    ) : (
                        <span className="tree-row">
                            <Icon name={node.kind === 'dir' ? 'folder' : 'file'} size={16} />
                            <span>{node.name}</span>
                        </span>
                    )}
                    {node.children ? (
                        <Tree nodes={node.children} selected={selected} onSelect={onSelect} hasPreview={hasPreview} />
                    ) : null}
                </li>
            ))}
        </ul>
    );
}

export function FilesPanel({ model }: { model: FilesModel }) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<string | null>(null);
    const [showAll, setShowAll] = useState<string | null>(null);
    const preview = (picked ? model.previews.get(picked) : null) ?? model.latest;
    if (model.roots.length === 0 && !preview) {
        return <p className="muted empty files-empty">{t('wb.files.empty')}</p>;
    }
    const expanded = preview !== null && showAll === preview.path;
    const hidden = preview ? Math.max(0, preview.lines.length - PREVIEW_MAX_LINES) : 0;
    const shown = preview ? (expanded ? preview.lines : preview.lines.slice(0, PREVIEW_MAX_LINES)) : [];
    return (
        <div className="files-panel" data-testid="files-panel">
            <aside className="explorer" aria-label={t('wb.files.explorer')}>
                <h3>{t('wb.files.explorer')}</h3>
                {model.roots.length > 0 ? (
                    <Tree
                        nodes={model.roots}
                        selected={preview?.path ?? null}
                        onSelect={setPicked}
                        hasPreview={(path) => model.previews.has(path)}
                    />
                ) : null}
            </aside>
            <div className="file-preview">
                {preview ? (
                    <>
                        <div className="preview-head">
                            <Icon name="file" size={16} />
                            <span className="preview-path">{preview.path}</span>
                            <span className="small muted">
                                {[languageOf(preview.path), t('wb.files.lines', { n: preview.lines.length })]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </span>
                        </div>
                        <p className="small muted">{t('wb.files.untrusted')}</p>
                        <ol className="code-lines" data-testid="file-lines">
                            {shown.map((line, i) => (
                                <li key={i} value={i + 1}>
                                    <code>{line || ' '}</code>
                                </li>
                            ))}
                        </ol>
                        {hidden > 0 && !expanded ? (
                            <button type="button" className="link small" onClick={() => setShowAll(preview.path)}>
                                {t('wb.files.moreLines', { n: hidden })}
                            </button>
                        ) : null}
                        {preview.truncated ? <p className="small warning">{t('wb.files.truncated')}</p> : null}
                    </>
                ) : (
                    <p className="muted empty">{t('wb.files.noPreview')}</p>
                )}
            </div>
        </div>
    );
}
