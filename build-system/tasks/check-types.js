/**
 * Copyright 2019 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const argv = require('minimist')(process.argv.slice(2));
const globby = require('globby');
const {
  createCtrlcHandler,
  exitCtrlcHandler,
} = require('../common/ctrlcHandler');
const {
  displayLifecycleDebugging,
} = require('../compile/debug-compilation-lifecycle');
const {cleanupBuildDir, closureCompile} = require('../compile/compile');
const {compileCss} = require('./css');
const {cyan, green, yellow, red} = require('kleur/colors');
const {extensions, maybeInitializeExtensions} = require('./extension-helpers');
const {log} = require('../common/logging');
const {typecheckNewServer} = require('../server/typescript-compile');

const EXTERNS_GLOB = 'src/core{,/**}/*.extern.js';

/**
 * Generates a list of source file paths for extensions to type-check
 * Must be run after `maybeInitializeExtensions`
 * @function
 * @return {!Array<string>}
 */
const getExtensionSrcPaths = () =>
  Object.values(extensions)
    .filter((ext) => !ext.noTypeCheck)
    .map(({name, version}) => `extensions/${name}/${version}/${name}.js`)
    .sort();

/**
 * The main configuration location to add/edit targets for type checking.
 * Properties besides `entryPoints` are passed on to `closureCompile` as
 * options. * Values may be objects or functions, as some require initialization
 * or filesystem access and shouldn't be run until needed.
 * @type {Object<string, Object|function():Object>}
 */
const TYPE_CHECK_TARGETS = {
  'src': {
    entryPoints: [
      'src/amp.js',
      'src/amp-shadow.js',
      'src/inabox/amp-inabox.js',
      'ads/alp/install-alp.js',
      'ads/inabox/inabox-host.js',
      'src/web-worker/web-worker.js',
    ],
    extraGlobs: ['src/inabox/*.js', '!node_modules/preact'],
    warningLevel: 'QUIET',
  },
  'src-core': () => ({
    externs: globby.sync(EXTERNS_GLOB),
    extraGlobs: [
      // Include all core JS files
      'src/core/{,**/}*.js',
      // Exclude all core extern files (already included via externs)
      `!${EXTERNS_GLOB}`,
    ],
  }),
  'extensions': () => ({
    entryPoints: getExtensionSrcPaths(),
    extraGlobs: ['src/inabox/*.js', '!node_modules/preact'],
    warningLevel: 'QUIET',
  }),
  'integration': {
    entryPoints: '3p/integration.js',
    externs: ['ads/ads.extern.js'],
    warningLevel: 'QUIET',
  },
  'ampcontext': {
    entryPoints: '3p/ampcontext-lib.js',
    externs: ['ads/ads.extern.js'],
    warningLevel: 'QUIET',
  },
  'iframe-transport-client': {
    entryPoints: '3p/iframe-transport-client-lib.js',
    externs: ['ads/ads.extern.js'],
    warningLevel: 'QUIET',
  },
};

/**
 * Performs closure type-checking on the target provided.
 * @param {string} targetName key in TYPE_CHECK_TARGETS
 * @return {!Promise<void>}
 */
async function typeCheck(targetName) {
  let target = TYPE_CHECK_TARGETS[targetName];
  if (typeof target == 'function') {
    target = target();
  }

  if (!target) {
    log(
      red('ERROR:'),
      'No type-check configuration defined for target',
      cyan(targetName)
    );
    throw new Error(
      `No type-check configuration defined for target ${targetName}`
    );
  }

  const {entryPoints = [], ...opts} = target;
  // If no entry point is defined, we want to scan the globs provided without
  // injecting extra dependencies.
  const noAddDeps = !entryPoints.length;
  // If the --warning_level flag is passed explicitly, it takes precedence.
  opts.warningLevel = argv.warning_level || opts.warningLevel || 'VERBOSE';

  // For type-checking, QUIET suppresses all warnings and can't affect the
  // resulting status, so there's no point in doing it.
  if (opts.warningLevel == 'QUIET') {
    log(
      yellow('WARNING:'),
      'Warning level for target',
      cyan(targetName),
      `is set to ${cyan('QUIET')}; skipping`
    );
    return;
  }

  await closureCompile(entryPoints, './dist', `${targetName}-check-types.js`, {
    noAddDeps,
    include3pDirectories: !noAddDeps,
    includePolyfills: !noAddDeps,
    typeCheckOnly: true,
    ...opts,
  });
  log(green('SUCCESS:'), 'Type-checking passed for target', cyan(targetName));
}

/**
 * Runs closure compiler's type checker against all AMP code.
 * @return {!Promise<void>}
 */
async function checkTypes() {
  const handlerProcess = createCtrlcHandler('check-types');

  // Prepare build environment
  process.env.NODE_ENV = 'production';
  cleanupBuildDir();
  maybeInitializeExtensions();
  typecheckNewServer();
  await compileCss();

  // Use the list of targets if provided, otherwise check all targets
  const targets = argv.targets
    ? argv.targets.split(/,/)
    : Object.keys(TYPE_CHECK_TARGETS);

  log(`Checking types for targets: ${targets.map(cyan).join(', ')}`);
  displayLifecycleDebugging();

  await Promise.all(targets.map(typeCheck));
  exitCtrlcHandler(handlerProcess);
}

module.exports = {
  checkTypes,
};

/* eslint "google-camelcase/google-camelcase": 0 */

checkTypes.description = 'Check source code for JS type errors';
checkTypes.flags = {
  closure_concurrency: 'Sets the number of concurrent invocations of closure',
  debug: 'Outputs the file contents during compilation lifecycles',
  targets: 'Comma-delimited list of targets to type-check',
  warning_level:
    "Optionally sets closure's warning level to one of [quiet, default, verbose]",
};
