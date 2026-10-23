'use strict';

// Must be the very first import: it installs the globals that the modules
// under test touch at import time (localStorage, document, window, navigator).
import './setup';

import './lyrics.test';
import './common.test';
import './db-url-guard.test';
import './settings-defaults.test';
import './audio-analyser.test';
import './harness-self.test';

export { run } from './harness';
