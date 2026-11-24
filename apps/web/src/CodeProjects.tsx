// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 设置 → 工具 → 代码(ADR 0049 第 3.1 节):开关、登记项目与允许 code.run 运行的命令。
// 项目路径由服务器检查(在授权文件夹之内、是 git 仓库)并换成真实路径;这里只把错误原样显示出来。
import type { CodeProjectInput, FsRoot, Settings } from '@fatcat-ai/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorText } from './api.js';
import { SettingsGroup, Switch } from './controls.js';
import { useI18n } from './i18n.js';

/** 路径是否在某个授权文件夹里(只按字符串判断,用来在页面上标红;真正的检查在服务器)。 */
export function insideRoots(path: string, roots: readonly string[]): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(path);
    return roots.some((r) => {
        const root = norm(r);
        return target === root || target.startsWith(`${root}/`);
    });
}

export function CodeProjects({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
    const { t } = useI18n();
    const code = settings.code ?? { enabled: false, projects: [] };
    const [roots, setRoots] = useState<FsRoot[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [path, setPath] = useState('');

    useEffect(() => {
        let alive = true;
        api.fsRoots
            .list()
            .then((page) => alive && setRoots(page.items))
            .catch(() => alive && setRoots([]));
        return () => {
            alive = false;
        };
    }, []);

    const save = async (patch: { enabled?: boolean; projects?: CodeProjectInput[] }) => {
        setError(null);
        try {
            onSettings(await api.settings.update({ code: patch }));
            return true;
        } catch (e) {
            setError(errorText(e));
            return false;
        }
    };

    const addProject = async (e: FormEvent) => {
        e.preventDefault();
        const ok = await save({ projects: [...code.projects, { name: name.trim(), path: path.trim(), commands: [] }] });
        if (ok) {
            setName('');
            setPath('');
        }
    };

    const removeProject = (id: string) => {
        const project = code.projects.find((p) => p.id === id);
        if (!project || !window.confirm(t('code.removeConfirm', { name: project.name }))) return;
        void save({ projects: code.projects.filter((p) => p.id !== id) });
    };

    const setCommands = (id: string, commands: CodeProjectInput['commands']) =>
        save({ projects: code.projects.map((p) => (p.id === id ? { ...p, commands } : p)) });

    return (
        <SettingsGroup title={t('code.title')}>
            <Switch
                name="codeEnabled"
                label={t('code.enabled')}
                hint={t('code.enabledHint')}
                risk
                checked={code.enabled}
                onChange={(enabled) => void save({ enabled })}
            />
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}
            {code.projects.length === 0 ? <p className="muted small">{t('code.empty')}</p> : null}
            <ul className="list code-projects">
                {code.projects.map((p) => {
                    const lost =
                        roots !== null &&
                        !insideRoots(
                            p.path,
                            roots.map((r) => r.path),
                        );
                    return (
                        <li key={p.id} className="card" data-code-project={p.name} data-lost={lost ? '' : undefined}>
                            <div className="row spread">
                                <div>
                                    <strong>{p.name}</strong>
                                    <span className="small muted"> · {p.path}</span>
                                </div>
                                <button type="button" className="danger" onClick={() => removeProject(p.id)}>
                                    {t('code.remove')}
                                </button>
                            </div>
                            {lost ? (
                                <p className="error small" role="status">
                                    {t('code.lost')}
                                </p>
                            ) : null}
                            <CommandList commands={p.commands} onChange={(commands) => setCommands(p.id, commands)} />
                        </li>
                    );
                })}
            </ul>
            <form className="row wrap" onSubmit={addProject} data-testid="code-add-project">
                <input
                    aria-label={t('code.name')}
                    placeholder={t('code.name')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                    required
                />
                <input
                    aria-label={t('code.path')}
                    placeholder={t('code.pathPlaceholder')}
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    spellCheck={false}
                    required
                />
                <button type="submit" className="primary">
                    {t('code.add')}
                </button>
            </form>
            <p className="small muted">{t('code.pathHint')}</p>
        </SettingsGroup>
    );
}

function CommandList({
    commands,
    onChange,
}: {
    commands: CodeProjectInput['commands'];
    onChange: (next: CodeProjectInput['commands']) => Promise<boolean>;
}) {
    const { t } = useI18n();
    const [name, setName] = useState('');
    const [argv, setArgv] = useState('');
    const [minutes, setMinutes] = useState('');

    const add = async (e: FormEvent) => {
        e.preventDefault();
        const timeout = Number(minutes);
        const command = {
            name: name.trim(),
            argv: argv.trim().split(/\s+/).filter(Boolean),
            ...(minutes.trim() && Number.isInteger(timeout) ? { timeoutMinutes: timeout } : {}),
        };
        if (await onChange([...commands, command])) {
            setName('');
            setArgv('');
            setMinutes('');
        }
    };

    return (
        <div className="code-commands">
            <p className="small">{t('code.commands')}</p>
            {commands.length === 0 ? <p className="small muted">{t('code.noCommands')}</p> : null}
            <ul className="list">
                {commands.map((c) => (
                    <li key={c.name} className="row spread small">
                        <code>
                            {c.name}: {c.argv.join(' ')}
                            {c.timeoutMinutes ? ` (${t('code.timeoutShort', { n: c.timeoutMinutes })})` : ''}
                        </code>
                        <button
                            type="button"
                            className="link small"
                            onClick={() => void onChange(commands.filter((x) => x.name !== c.name))}
                        >
                            {t('code.removeCommand')}
                        </button>
                    </li>
                ))}
            </ul>
            <form className="row wrap" onSubmit={add}>
                <input
                    aria-label={t('code.commandName')}
                    placeholder={t('code.commandName')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    pattern="[a-z0-9\-]{1,32}"
                    size={10}
                    required
                />
                <input
                    aria-label={t('code.argv')}
                    placeholder={t('code.argvPlaceholder')}
                    value={argv}
                    onChange={(e) => setArgv(e.target.value)}
                    spellCheck={false}
                    required
                />
                <input
                    aria-label={t('code.timeout')}
                    placeholder={t('code.timeout')}
                    type="number"
                    min={1}
                    max={60}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                    className="code-timeout"
                />
                <button type="submit">{t('code.addCommand')}</button>
            </form>
        </div>
    );
}
