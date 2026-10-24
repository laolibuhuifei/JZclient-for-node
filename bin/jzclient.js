#!/usr/bin/env node
try {
  require('../src/cli');
} catch (e) {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
}
