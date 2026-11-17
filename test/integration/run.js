// Runs test/integration/suite.js inside a real VS Code instance.
'use strict';
const path = require('path');
// when launched from a VS Code terminal this would make Electron behave as plain Node
delete process.env.ELECTRON_RUN_AS_NODE;

const { runTests } = require('@vscode/test-electron');

runTests({
  version: process.env.VSCODE_VERSION || 'stable',
  extensionDevelopmentPath: path.resolve(__dirname, '../..'),
  extensionTestsPath: path.resolve(__dirname, 'suite.js'),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
}).catch(err => {
  console.error(err);
  process.exit(1);
});
