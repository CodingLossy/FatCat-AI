// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 凭据检测语料(M2 方案 PR 11:≥ 60 条正例、≥ 60 条反例,正例召回 100%、误报 ≤ 5%)。
// 所有「密钥」都是运行时用固定种子拼出来的假值:源文件里没有完整的密钥串,
// 这样 `pnpm check:secrets` 与代码托管平台的推送保护都不会把语料当成真实泄漏。

/** 确定性的伪随机串(线性同余),同一 seed 每次结果相同。 */
function fake(
    seed: number,
    length: number,
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
): string {
    let x = seed;
    let out = '';
    for (let i = 0; i < length; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        out += alphabet[(x >>> 16) % alphabet.length]; // 低位周期短,取高位
    }
    return out;
}

const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const join = (...parts: string[]) => parts.join('');

/** 正例:必须全部被拒存。 */
export const CREDENTIAL_POSITIVES: readonly string[] = [
    // 密钥前缀
    `我的 OpenAI key 是 ${join('sk', '-proj-', fake(1, 40))}`,
    `记住这个 key:${join('sk', '-', fake(2, 48))}`,
    `Anthropic 的密钥 ${join('sk', '-ant-api03-', fake(3, 60))}`,
    `deepseek 用 ${join('sk', '-', fake(4, 32, '0123456789abcdef'))}`,
    `stripe live key ${join('sk', '_live_', fake(5, 24))}`,
    `restricted key ${join('rk', '_live_', fake(6, 24))}`,
    `Google Maps 的 key 是 ${join('AI', 'za', fake(7, 35))}`,
    `AWS access key id ${join('AK', 'IA', fake(8, 16, UPPER_NUM))}`,
    `临时凭证 ${join('AS', 'IA', fake(9, 16, UPPER_NUM))}`,
    `huggingface token ${join('hf', '_', fake(10, 34))}`,
    // 访问令牌
    `GitHub token ${join('gh', 'p_', fake(11, 36))}`,
    `fine-grained PAT: ${join('github', '_pat_', fake(12, 60))}`,
    `GitHub OAuth ${join('gh', 'o_', fake(13, 36))}`,
    `GitLab 令牌 ${join('gl', 'pat-', fake(14, 20))}`,
    `slack bot ${join('xo', 'xb-', fake(15, 12, '0123456789'), '-', fake(16, 24))}`,
    `slack user token ${join('xo', 'xp-', fake(17, 30))}`,
    `本机 API 令牌 ${join('aip', '_pat_', fake(18, 32))}`,
    `curl -H "Authorization: Bearer ${fake(19, 40)}"`,
    // JWT
    `会话令牌 ${join('ey', 'J', fake(20, 20))}.${join('ey', 'J', fake(21, 40))}.${fake(22, 43)}`,
    `jwt=${join('ey', 'J', fake(23, 16))}.${join('ey', 'J', fake(24, 24))}.${fake(25, 32)}`,
    // 私钥
    `${join('-----BEGIN ', 'RSA PRIVATE KEY-----')} MIIEowIBAAKCAQEA`,
    `${join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')} b3BlbnNzaC1rZXktdjEAAAAA`,
    `${join('-----BEGIN ', 'PRIVATE KEY-----')} MIGHAgEAMBMGByqGSM49`,
    `${join('-----BEGIN ', 'EC PRIVATE KEY-----')}`,
    `${join('-----BEGIN ', 'PGP PRIVATE KEY BLOCK-----')}`,
    // URL 中的用户名与密码
    `数据库连接 postgres://admin:${fake(26, 12)}@db.example.com:5432/app`,
    `redis://default:${fake(27, 16)}@cache.internal:6379`,
    `mongodb+srv://ops:${fake(28, 10)}@cluster0.example.net/test`,
    // TOTP 种子
    `otpauth://totp/GitHub:me?secret=${fake(29, 32, BASE32)}&issuer=GitHub`,
    `谷歌验证器的密钥 ${fake(30, 16, BASE32)}2`,
    `两步验证种子:${fake(31, 4, BASE32)} ${fake(32, 4, BASE32)} ${fake(33, 4, BASE32)} 7${fake(34, 3, BASE32)}`,
    `2FA backup secret 3${fake(35, 31, BASE32)}`,
    `TOTP seed is ${fake(36, 20, BASE32)}6`,
    // 中文「密码是…」
    '我的密码是 Hunter2!2026',
    '密码是：123456',
    '我的邮箱密码为 qwerty@2024',
    '银行卡密码是 880512',
    '公司电脑的开机密码:Abc#2025',
    'Wi-Fi 密码 是 tplink8888',
    '家里路由器的管理密码是 admin1234',
    '支付宝支付密码 = 135790',
    '门禁口令是 open-sesame-42',
    '我的 QQ 密码为 woaini1314',
    '服务器 root 密码：P@ssw0rd!',
    '记住我的微信密码是 zhangsan_2026',
    // 英文 password 赋值
    'wifi password: correcthorse',
    'my gmail password is Tr0ub4dor&3',
    'the password for the router is linksys2024',
    'PASSWORD=supersecret99',
    'passwd: letmein!',
    'pwd = hunter22',
    'My PIN is 4821',
    'the alarm passcode is 9090',
    // token / secret 赋值
    `token=${fake(37, 24)}`,
    `client_secret: ${fake(38, 32)}`,
    `api key 是 ${fake(39, 28)}`,
    `access key = ${fake(40, 20, UPPER_NUM)}`,
    `密钥:${fake(41, 24)}`,
    `钉钉机器人的 secret 是 SEC${fake(42, 40, '0123456789abcdef')}`,
    // 高熵串
    `备用码 ${fake(43, 24)}`,
    `恢复密钥 ${fake(44, 8)}-${fake(45, 8)}-${fake(46, 8)}`,
    `webhook 签名 ${fake(47, 32)}`,
    `这串留着:${fake(48, 28)}`,
    `config value ${fake(49, 40)}`,
];

/** 反例:普通记忆内容,不应被拒存。 */
export const CREDENTIAL_NEGATIVES: readonly string[] = [
    '用户常住杭州',
    '用户喜欢简洁的中文回答',
    'The user prefers concise answers in Chinese',
    '项目使用 AGPL-3.0-only 许可证',
    '密码学是一门有趣的学科',
    '忘记密码时点击登录页的「找回密码」',
    '修改密码的入口在设置页',
    '用户希望每 90 天提醒他换一次密码',
    '用户在学习 RSA 公钥密码体制',
    '密码管理器用的是 Bitwarden',
    'The password is required to have 12 characters',
    'password reset links expire after one hour',
    'my password is not something I will share',
    'Use a password manager instead of reusing passwords',
    '每轮最多 4096 个 token',
    'max token = 4096',
    'token 数量限制是 8k',
    '模型上下文窗口是 128k tokens',
    'The secret to good bread is patience',
    'secret: santa',
    '用户的 GitHub 用户名是 CodingLossy',
    '仓库地址 https://github.com/CodingLossy/FatCat-AI',
    '文档在 https://example.com/docs/getting-started?tab=install#step-2',
    '用户的博客是 https://blog.example.org/2026/11/04/memory-v2-notes',
    'commit 8e12353 修复了迁移问题',
    '会话 id 是 01JBX3M5Q7R9T1V3W5Y7Z9A1C3',
    'UUID 550e8400-e29b-41d4-a716-446655440000 对应测试账号',
    '用户的生日是 3 月 12 日',
    '用户养了一只叫 Mochi 的猫',
    '用户每天早上 7 点跑步 5 公里',
    '用户正在读《三体》第二部',
    '用户的工作是后端工程师,主要写 TypeScript',
    '用户偏好 4 空格缩进与 120 列',
    '用户用 pnpm 而不是 npm',
    '模型用 gpt-4o-mini 做廉价任务',
    '用户喜欢 SK-II 神仙水',
    'sk 是用户名字的缩写',
    '下周三下午 3 点和张三开会',
    '决定 1.0 只做企业微信和微信渠道',
    '用户住在西湖区附近',
    '用户在 2026 年 11 月搬到上海',
    '用户的手机型号是 iPhone 15 Pro',
    '服务器有 2GB 内存,空闲 RSS 要低于 120 MiB',
    '数据库用 SQLite,开启 WAL',
    '用户讨厌在晚上 10 点后收到通知',
    '用户的车牌尾号是 7',
    '订单号 202611040001 已发货',
    '航班 CA1234 明早 8:05 起飞',
    '快递单号 SF1234567890123',
    '用户常用的端口是 8787 与 5173',
    'docker compose -f docker/docker-compose.yml up --build',
    '用户的 PIN 码策略是每季度更换',
    'two-factor authentication is enabled on the account',
    '两步验证已经打开',
    'OTP 短信有时会延迟',
    '用户用 Authenticator 应用管理两步验证',
    'The API key goes in the settings page, never in chat',
    'API key 要放进设置页,不要发在对话里',
    'Bearer tokens are sent in the Authorization header',
    'JWT 由 header、payload、signature 三段组成',
    'internationalization is spelled i18n',
    'Photosynthesis converts light energy into chemical energy',
    '用户喜欢的编程语言是 Rust 和 TypeScript',
];
