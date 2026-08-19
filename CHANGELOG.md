# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/).

## [2.0.0]

Version 2.0.0 preserves the basic 1.x logging API while substantially improving
reliability, observability, disk management, security, performance, and developer
experience.

### Added

#### Persistence and lifecycle

- Added `Log.flush()` to synchronously write buffered records, collapsed-repeat
  summaries, and rate-limit counters.
- Added an exit hook that drains records still pending in the current tick before a
  normal process exit.
- Added a bounded startup buffer so records created before `Log.setDir()` can be
  written to the directory selected by the application.
- Added automatic creation of nested log directories.
- Added daily file rotation by size through `Log.setRotateSize(bytes)`. Parts use
  names such as `YYYY-MM-DD.1.log`, never split a JSON record, and continue from the
  highest existing part after restart.
- Added retention by age with `Log.setPurgeDays(days)`.
- Added retention by total directory size with `Log.setPurgeSize(bytes)`.
- Added `Log.purge()` for an immediate retention pass. Retention also runs when a
  rule is configured, when the directory changes, and when the local day changes.

#### Reading and events

- Added optional minimum-severity and exact-name filters to
  `Log.getLogs(start, end, severity?, name?)`.
- Added `Log.offEvent(severity, callback?)` to remove one listener or every listener
  registered for a severity.
- Changed `Log.getLatestLogs()` to return a shallow array copy so callers cannot
  mutate the internal history container.

#### Flood protection

- Added `Log.setCollapseRepeats(true)` to fold equivalent consecutive records into a
  summary count.
- Added `Log.setRateLimit(perSecond)` to cap accepted records and emit a `WARN`
  explaining how many were dropped.
- Added hard memory ceilings for directory buffering, the write queue, recent
  history, and open file descriptors.

#### Security and failure handling

- Added `Log.setRedact(keys)` to mask case-insensitive payload keys up to eight
  levels deep without mutating the object supplied by the caller.
- Added `Log.setSanitizePrint(boolean)` to control terminal sanitization of names and
  messages.
- Added `Log.setCatchCrashes(true)` to record uncaught exceptions and unhandled
  rejections as `FATAL`, flush them, and preserve the application's own handlers.
- Added guarded serialization for circular references, `BigInt`, `Error` values,
  throwing getters, and otherwise unserializable payloads.

#### Configuration

- Added `Log.setStackDepth(frames)` to trade retained stack detail for lower capture
  overhead.
- Added import-time `WA_LOG_*` configuration:
  - `WA_LOG_DIR`
  - `WA_LOG_LEVEL_SHOW`
  - `WA_LOG_LEVEL_SAVE`
  - `WA_LOG_CONSOLE`
  - `WA_LOG_PATH_PRINT`
  - `WA_LOG_FILE_PRINT`
  - `WA_LOG_OBJECT_PRINT`
  - `WA_LOG_SANITIZE`
  - `WA_LOG_STACK_DEPTH`
  - `WA_LOG_PURGE_DAYS`
  - `WA_LOG_PURGE_SIZE`
  - `WA_LOG_ROTATE_SIZE`
  - `WA_LOG_COLLAPSE_REPEATS`
  - `WA_LOG_RATE_LIMIT`
  - `WA_LOG_REDACT`
  - `WA_LOG_CATCH_CRASHES`

#### Tooling and documentation

- Added TypeScript as a project development dependency instead of relying on a
  globally installed compiler.
- Added `tsx` and an executable sample through `npm run sample`.
- Added `npm test`, which builds the package and runs every test suite in an isolated
  process and temporary working directory.
- Added `prepare` so the package is built before packaging and installation from the
  repository.
- Added an English README with quick-start instructions, use cases, complete API
  reference, environment configuration, operational guidance, and performance notes.
- Rewrote and expanded the exported JSDoc, including field-level `LogData`
  documentation for editor IntelliSense.

### Changed

#### Runtime and package

- Raised the minimum supported runtime to Node.js 18.
- Explicitly declared the package as CommonJS while continuing to publish
  `dist/index.js` and `dist/index.d.ts`.
- Updated the build to TypeScript 7, target ES2017, Node 18 module output, and Node 16
  module resolution.
- Updated the publish workflow to run the full test suite before publishing.
- Widened the first parameter of `Log.catch` from `Error` to `unknown`, matching
  modern TypeScript catch bindings and JavaScript's ability to throw any value.

#### Console output

- Removed underscore padding around severity names.
- Standardized every colored severity block to five visible characters.
- Added a colored background for the generic `LOG` level.
- Reduced the timestamp-to-severity separator to one space.
- Replaced fixed name, full-path, and filename columns with adaptive columns that grow
  only as needed during the process.
- Added upper bounds of 20 characters for names, 80 for full paths, and 30 for
  filenames. Oversized names keep their beginning; oversized locations keep their
  useful tail.
- Kept log names in brackets to preserve their visual role as category tags.
- Moved payloads to a separate indented line and preserved indentation for multiline
  object inspection.
- Removed unnecessary message and empty-column padding from terminal output.

#### Disk writes

- Replaced one asynchronous `fs.appendFile` call per record with an ordered,
  once-per-tick write queue.
- Reused one open file handle instead of opening and closing the file for every
  record.
- Resolved the daily destination once per day or directory change instead of once per
  log call.
- Made retention and file rotation local-date aware.

### Fixed

#### Lost or corrupted logs

- Fixed records disappearing during bursts when many independent `fs.appendFile`
  operations were issued and callback errors were ignored.
- Fixed records reaching disk out of order under concurrent asynchronous appends.
- Fixed records logged immediately before `process.exit()` being lost.
- Fixed early records being written to `./logs` before the application could select
  its intended directory.
- Fixed a circular reference, `BigInt`, throwing getter, or serialization failure
  causing the entire record to be dropped.
- Fixed short or missing stacks crashing the logger.

#### Windows paths and stack parsing

- Fixed source paths being cut at the drive-letter colon, which previously produced
  `local: "C"` and placed the remaining path in `cursor`.
- Fixed error stack headers being mistaken for call frames when Windows backslashes
  were present.
- Split source cursors from the final colons in a frame so `C:\...\file.ts:18:5`
  resolves correctly.

#### Reading persisted logs

- Fixed `getLogs` returning no records between local midnight and UTC midnight by
  aligning file selection with local-date filenames.
- Ignored files that do not match `YYYY-MM-DD.log` or `YYYY-MM-DD.N.log`.
- Rejected invalid calendar dates that JavaScript would otherwise normalize into a
  different month.
- Preserved chronological part ordering when reading a rotated day.
- Avoided holding a second array containing every line of a large file during reads.
- Added a pre-parse exact-name check to skip irrelevant JSON records efficiently.

#### Console capture and listeners

- Prevented a second installed copy of `wa-log` from wrapping an already wrapped
  console and causing recursion or duplicated capture.
- Ensured logging from inside event callbacks cannot recursively enter the logger.
- Ensured `offEvent` releases listener functions and the closures they retain.
- Sanitized control characters and user-supplied ANSI escape sequences in displayed
  names and messages while retaining the logger's own severity colors.

### Security

- Log directories are created with owner-only mode `0700` where the platform supports
  POSIX permissions.
- Log files are opened with owner-only mode `0600` where supported.
- Terminal sanitization is enabled by default to prevent log content from repainting
  the terminal or forging additional lines.
- Redaction now reaches the console, persisted files, in-memory history, and event
  listeners consistently.

### Performance

- Reduced the measured per-record cost from approximately 162 microseconds to 28
  microseconds in the project's 20,000-record benchmark.
- Captured stacks without a throw/catch cycle, saving approximately 8 microseconds per
  record in that benchmark.
- Added `setStackDepth` as the primary performance control; each retained frame cost
  approximately 2.5 microseconds in the same measurement.
- Reduced filesystem overhead by batching writes and retaining the active file handle.
- Attempted plain `JSON.stringify` first and used guarded serialization only after a
  failure.
- Avoided rebuilding recent-history arrays and daily paths for every record.

### Memory

- Limited in-memory history to 100 records.
- Limited records waiting for directory selection to 500.
- Limited the pending disk queue to 1 MB before forcing a drain.
- Kept at most one active file descriptor.
- Verified stable memory usage across the project's 160,000-record stress test.

### Tests

- Added 122 checks across seven process-isolated suites:
  - core logging, stack handling, sanitization, and history;
  - adaptive console formatting and multiline payloads;
  - startup buffering and environment configuration;
  - ordered file writes and process-exit flushing;
  - rotation, redaction, flood guards, filters, and crash capture;
  - age-based and size-based retention;
  - bounded memory behavior under sustained logging.

### Compatibility

- Existing calls to `Log.trace`, `debug`, `log`, `info`, `warn`, `error`, `fatal`,
  `setLevel`, `setDir`, `getLastLog`, `getLatestLogs`, `getLogs`, and `onEvent` remain
  supported.
- `Log.catch` accepts everything previously accepted and now also accepts non-`Error`
  thrown values.
- The package remains consumable from both TypeScript `import` syntax and CommonJS
  `require`.
