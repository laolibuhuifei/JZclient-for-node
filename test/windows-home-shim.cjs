'use strict';
// 上游测试通过 HOME 隔离临时目录；Windows 的 os.homedir() 默认读 USERPROFILE。
// 仅供 node --test --require 使用，确保测试不会读取或改写当前用户真实配置。
const os = require('node:os');
const originalHome = os.homedir;
os.homedir = function testHome() { return process.env.HOME || originalHome(); };
