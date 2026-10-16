#!/usr/bin/env node
import { main } from '../src/cli.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`localcloud needs Node.js 18 or newer (you have ${process.version}).`);
  process.exit(1);
}

main(process.argv.slice(2));
