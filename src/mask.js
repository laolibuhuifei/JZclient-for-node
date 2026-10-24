// 终端输出脱敏: 手机号/身份证/邮箱/银行卡
// 例: 917813 -> 91****13

function maskSensitive(input) {
  if (typeof input !== 'string' || !input) return input;

  // 暂存 ANSI 颜色转义序列, 避免其结尾字母影响边界判断
  const codes = [];
  let s = input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, (m) => {
    codes.push(m);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 手机号(可带 +86 / 86- 前缀), 保留前 3 后 4
  // 边界排除字母数字, 避免误伤 watchId / token 等十六进制串
  s = s.replace(/(?<![0-9A-Za-z])((?:\+?86[-\s]?)?)(1[3-9]\d)\d{4}(\d{4})(?![0-9A-Za-z])/g,
    (m, prefix, head, tail) => `${prefix}${head}****${tail}`);

  // 18 位身份证, 保留前 6 后 4
  s = s.replace(/(?<![0-9A-Za-z])(\d{6})\d{8}(\d{3}[\dXx])(?![0-9A-Za-z])/g, '$1********$2');

  // 邮箱, 保留前 2 位
  s = s.replace(/([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    '$1***@$2');

  // 银行卡 16-19 位, 保留前 4 后 4
  s = s.replace(/(?<![0-9A-Za-z])(\d{4})\d{8,11}(\d{4})(?![0-9A-Za-z])/g, '$1 **** **** $2');

  // 还原 ANSI 转义序列
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)] || '');
}

module.exports = { maskSensitive };
