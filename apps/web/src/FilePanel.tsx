// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 文件树和只读预览。文本来自工具结果或条目内容,按文本节点渲染,不做 HTML。
import type { IconName } from '@fatcat-ai/ui/icons';
import { useEffect, useState } from 'react';
import {
    clipPreview,
    languageOf,
    PREVIEW_MAX_BYTES,
    PREVIEW_MAX_LINES,
    type FilePreview,
    type TreeNode,
} from './file-workspace.js';
import type { HighlightSpan } from './highlight.js';
import { Icon } from './Icon.js';
import { useI18n } from './i18n.js';

export function PreviewBody({
    path,
    text,
    truncatedByTool,
    highlightLine: marked,
    added = false,
    notice,
    onLine,
}: {
    path: string;
    text: string;
    truncatedByTool: boolean;
    highlightLine: number | null;
    /** fs.write 还没有旧版本时,整段按新增行显示。 */
    added?: boolean;
    notice?: string;
    onLine?: (line: number) => void;
}) {
    const { t } = useI18n();
    const [more, setMore] = useState(false);
    const [colorize, setColorize] = useState<((code: string, language: string | null) => HighlightSpan[]) | null>(null);
    useEffect(() => {
        let alive = true;
        void import('./highlight.js').then(
            (mod) => {
                if (alive) setColorize(() => mod.highlightLine);
            },
            () => undefined,
        );
        return () => {
            alive = false;
        };
    }, []);
    const shown = more ? text : clipPreview(text).text;
    const clipped = shown !== text;
    const lines = shown.split('\n');
    const language = languageOf(path);
    return (
        <div className="wb-editor">
            <div className="wb-tabs">
                <span className="on">
                    <Icon name="file" size={16} />
                    {path.split(/[/\\]/).pop()}
                </span>
            </div>
            <div className="wb-crumbs">{path}</div>
            <p className="wb-untrusted">{notice ?? t('wb.untrusted')}</p>
            <div className="wb-code" role="region" aria-label={path}>
                {lines.map((line, index) => {
                    const number = index + 1;
                    const spans = colorize ? colorize(line, language) : [{ text: line, cls: null }];
                    const hot = marked === number;
                    return (
                        <div
                            key={number}
                            className={`wb-ln${hot ? ' hl' : ''}${added ? ' add' : ''}`}
                            onClick={() => onLine?.(number)}
                        >
                            <i>{number}</i>
                            {added ? <s>+</s> : null}
                            <span>
                                {spans.map((span, i) => (
                                    <Span key={i} span={span} />
                                ))}
                            </span>
                        </div>
                    );
                })}
            </div>
            {clipped ? (
                <button type="button" className="link small wb-more" onClick={() => setMore(true)}>
                    {t('wb.previewMore')}
                </button>
            ) : null}
            {truncatedByTool ? <p className="small muted wb-more">{t('wb.previewTruncated')}</p> : null}
        </div>
    );
}

function Span({ span }: { span: HighlightSpan }) {
    return span.cls ? <span className={span.cls}>{span.text}</span> : <>{span.text}</>;
}

function Tree({
    nodes,
    depth,
    selected,
    open,
    onToggle,
    onSelect,
}: {
    nodes: TreeNode[];
    depth: number;
    selected: string | null;
    open: ReadonlySet<string>;
    onToggle: (path: string) => void;
    onSelect: (path: string) => void;
}) {
    return (
        <ul className="wb-tree">
            {nodes.map((node) => {
                const expanded = open.has(node.path);
                return (
                    <li key={node.path}>
                        <button
                            type="button"
                            className={node.path === selected ? 'sel' : ''}
                            style={{ paddingLeft: `${12 + depth * 14}px` }}
                            onClick={() => (node.kind === 'dir' ? onToggle(node.path) : onSelect(node.path))}
                        >
                            <Icon name={iconFor(node, expanded)} size={16} />
                            <span>{node.name}</span>
                        </button>
                        {node.kind === 'dir' && expanded ? (
                            <Tree
                                nodes={node.children}
                                depth={depth + 1}
                                selected={selected}
                                open={open}
                                onToggle={onToggle}
                                onSelect={onSelect}
                            />
                        ) : null}
                    </li>
                );
            })}
        </ul>
    );
}

function iconFor(node: TreeNode, expanded: boolean): IconName {
    if (node.kind === 'file') return 'file';
    return expanded ? 'down' : 'fwd';
}

function ancestorPaths(path: string, nodes: readonly TreeNode[]): string[] {
    const found: string[] = [];
    const walk = (list: readonly TreeNode[], parents: string[]): boolean => {
        for (const node of list) {
            if (node.path === path) {
                found.push(...parents);
                return true;
            }
            if (walk(node.children, [...parents, node.path])) return true;
        }
        return false;
    };
    walk(nodes, []);
    return found;
}

export function FileTree({
    rootLabel,
    roots,
    previews,
    selectedPath,
    extra,
    onSelect,
    onLine,
}: {
    rootLabel: string;
    roots: TreeNode[];
    previews: Map<string, FilePreview>;
    selectedPath: string | null;
    /** 从搜索打开、不在本轮工具结果里的文本。 */
    extra: FilePreview | null;
    onSelect: (path: string) => void;
    onLine: (line: number, language: string | null) => void;
}) {
    const { t } = useI18n();
    const [openedByUser, setOpenedByUser] = useState<ReadonlySet<string>>(() => new Set());
    const [closedByUser, setClosedByUser] = useState<ReadonlySet<string>>(() => new Set());
    const open = new Set<string>(openedByUser);
    if (selectedPath) {
        for (const path of ancestorPaths(selectedPath, roots)) {
            if (!closedByUser.has(path)) open.add(path);
        }
    }

    const preview =
        (selectedPath && previews.get(selectedPath)) || (extra && extra.path === selectedPath ? extra : null);

    if (roots.length === 0 && !extra) {
        return <p className="wb-empty">{t('wb.explorerEmpty')}</p>;
    }
    return (
        <div className="wb-files">
            {roots.length > 0 ? (
                <aside className="wb-explorer">
                    <h5>{rootLabel || t('wb.explorer')}</h5>
                    <Tree
                        nodes={roots}
                        depth={0}
                        selected={selectedPath}
                        open={open}
                        onToggle={(path) => {
                            if (open.has(path)) {
                                setClosedByUser((prev) => new Set(prev).add(path));
                                setOpenedByUser((prev) => {
                                    const next = new Set(prev);
                                    next.delete(path);
                                    return next;
                                });
                            } else {
                                setOpenedByUser((prev) => new Set(prev).add(path));
                                setClosedByUser((prev) => {
                                    const next = new Set(prev);
                                    next.delete(path);
                                    return next;
                                });
                            }
                        }}
                        onSelect={onSelect}
                    />
                </aside>
            ) : null}
            {preview ? (
                <PreviewBody
                    path={preview.path}
                    text={preview.text}
                    truncatedByTool={preview.truncatedByTool}
                    highlightLine={preview.highlightLine}
                    onLine={(line) => onLine(line, languageOf(preview.path))}
                />
            ) : (
                <p className="wb-empty">{t('wb.previewEmpty')}</p>
            )}
        </div>
    );
}

export { PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES };
