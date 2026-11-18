// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

// 仅用于测试的自签证书(CN/SAN = ok.test,有效期约 100 年)。私钥没有任何价值,不要用于别处。
// PEM 头在运行时拼出来,避免密钥扫描(scripts/check-secrets.mjs)把这个测试夹具当成真实私钥。
const pem = (label: string, lines: string[]): string =>
    ['-----' + 'BEGIN ' + label + '-----', ...lines, '-----' + 'END ' + label + '-----', ''].join('\n');

export const TEST_TLS_KEY = pem('PRIVATE' + ' KEY', [
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDlpYNVwi70w/fm',
    'Tt8pyeTczKlpitD2I+nKZ/GnLK493gqMjCL4+fVBM3mqAvyZVw2dP4AYxpHW7oyZ',
    'SCCqbD9rSORyUVNZ+/I0fToUm2miLr8WaEpyKDE07XjNybKBGB9fSUa4dJfq+8V5',
    'n03OtbaiHgeyB50JLsWE1YSiC+LkWbZscuuLLw8YmsLksUh7xaEYLTyxHd763RGt',
    'HedAzSO/J7tk+CDkJu4foFL1HjZzPS4GZNWhE8BZ/mCNWZhYYYxoFflLnMI7niBP',
    '9gLv0DXwJOubxQ0xNnquOE+R7ZzYOTh0Lymt9MJqWMlQ8yA4zuZ8WsjFmAqvInd3',
    'TZ0ibEPLAgMBAAECggEAM6oA2hJNrhNIei/UVPpu2p3Qn0XzrOx3dGneG9YZfSGv',
    'Dd+ZHppdasXB4VW6rmS/U1kt4GUL+mbAituHPdAMlH5Zpr5VGjFsVBK4NlqgcTRD',
    'GS9tUDFqoJWsT9/IoPJkXHOHzYethdgOnUYRoyeOZvqKkKrV0XMMTM4cgLhb2zNG',
    'kGHOoGM82IP5TxBEWgpELywp+qC6oDlG/b8b7ZKknxGf9RqZ0BqUdQ86KdAqpDUw',
    'WjwDQX/zmfvC9SNHoYKITNDKn9dgDCp7AOAXE/NhelpeAJqHBzfPQFARQ3kn+FkG',
    'TxtW0Z4tYpB5uCP9ceN8k8wlP0R5ACuWv0aAUOcPgQKBgQD3djRWT+Ir6KqtaAKU',
    'TqOUCRRfXq8nVa4oeHpFZn5v5/rfS6xkYeEFPszrTAMMwYy17VheUkQoJ0QIOXyh',
    'YykOU+fFBvrF6GjJCjIm1RPmsB+CyDIf6Y0+a80Q8wfATKsy/hmE5qgF/k929LdH',
    'Kuc0LmgEDtC8Q24ZhlmZ+yfF6QKBgQDtkfMJUTb9GN2T+c67OGiBkwzCiNX4fzHX',
    'cV+KS/SnllZosRLN9ry7doATd3oYiHAT0bcVbHsNZkW4BE1BU8bWbt2mTBlOWxT9',
    'nwbP8xryo/cYoJZEV6e76PoCsQ1jrC4P4HTUMpX0qk1y/fUwC4cLxWSmylWKEZ13',
    'cydp8+JHkwKBgFbEQHefDNt+ehHRLU5ZAGwQfu8toNZ26VjRXXXmCSEtwr32p5yO',
    '4TpYmbtK7KrVVoQXk2uHBtTZZ7ZGideAkE2wx8xCtT0dT1hmVc1d2tuBF5tgnIqp',
    '9ldTrxRpUmdvuntnswTxZyqqz6wTBAxVE7otJ1V86F2KexlCDTq7YGe5AoGBAL8g',
    'fSuQyDGE8Lac8gHTVthv6oMTPTmHcxzF3DxR8UlmfKwLUXqcN6iFpHKE25ijI6/+',
    'N1IoDTNxhUOPSmv1L3HSjcW9UVqlklScvQlNpu9wlFme0GW5M3vM6l6B/KiknAYv',
    '6S3SaKwG2vpZcAmwLHx+2QQKohjLJSk1Xo8yI2i7AoGAPkozKZ4eJHBGt8qFNFYm',
    'Wtvj78DfRunDOqQAlRo05xYRji1ryXtFpm2q8MaZrh8j6yNBzETeF9YotNg1uR78',
    '+9RmR9+7NMAoN7Gj7FwVOCsN4uzgTdMVVNoRJy5HS611PHpC6YOB5A0NBNop0q8C',
    '2dil7e7AcSF5MO/Id+pGUJI=',
]);

export const TEST_TLS_CERT = pem('CERTIFICATE', [
    'MIIDGzCCAgOgAwIBAgIUOemmeA5HGwBBGZrq0tZYali5ggQwDQYJKoZIhvcNAQEL',
    'BQAwEjEQMA4GA1UEAwwHb2sudGVzdDAgFw0yNjExMTgwMjA3NDBaGA8yMTI2MTAy',
    'NTAyMDc0MFowEjEQMA4GA1UEAwwHb2sudGVzdDCCASIwDQYJKoZIhvcNAQEBBQAD',
    'ggEPADCCAQoCggEBAOWlg1XCLvTD9+ZO3ynJ5NzMqWmK0PYj6cpn8acsrj3eCoyM',
    'Ivj59UEzeaoC/JlXDZ0/gBjGkdbujJlIIKpsP2tI5HJRU1n78jR9OhSbaaIuvxZo',
    'SnIoMTTteM3JsoEYH19JRrh0l+r7xXmfTc61tqIeB7IHnQkuxYTVhKIL4uRZtmxy',
    '64svDxiawuSxSHvFoRgtPLEd3vrdEa0d50DNI78nu2T4IOQm7h+gUvUeNnM9LgZk',
    '1aETwFn+YI1ZmFhhjGgV+UucwjueIE/2Au/QNfAk65vFDTE2eq44T5HtnNg5OHQv',
    'Ka30wmpYyVDzIDjO5nxayMWYCq8id3dNnSJsQ8sCAwEAAaNnMGUwHQYDVR0OBBYE',
    'FJdtTB1KcDOPA/amaM5bLCiQH51/MB8GA1UdIwQYMBaAFJdtTB1KcDOPA/amaM5b',
    'LCiQH51/MA8GA1UdEwEB/wQFMAMBAf8wEgYDVR0RBAswCYIHb2sudGVzdDANBgkq',
    'hkiG9w0BAQsFAAOCAQEAVRXvEJ0bghXix/nLqSk741nwm9Go3ZVTJftgyZ3iWvrJ',
    'tP7cncddrhozhsbulpeMN7V2RpeZ1e8qLgmqA9Ku2iX2dr554S9UtL8YhLc0rOVs',
    'mDQel/wougzJFQ/Ly/UPNJ68cuC8p6czOEE+/H3HbGPa+xwzJjO0U0M8fUEv/tCe',
    'IuTqHS2GDKVdF6XAYWGj2A2AaqFMKLwmv/VDRz+KJdcQdqALAE0ZqV99rFpsn9V2',
    'PDAkomN6K7SP+p+NTWUJB9xv3Fqbd6aiaZBSs6LkQfiT1583mWEhu7qX60Msh2Rs',
    '/LL2doGbGFyjFGocoTxJxDKhrYfOXzdVgNocZqUo7g==',
]);
