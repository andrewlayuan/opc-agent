// 不允许进入记忆的敏感信息：API Key、手机号、身份证号、邮箱
const PATTERNS = [
  /\b(sk|ak|pk)-[A-Za-z0-9_-]{16,}/,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /(?<!\d)\d{17}[\dXx](?!\d)/,
  /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/,
];

export function hasSensitive(s: string): boolean {
  return PATTERNS.some((p) => p.test(s));
}
