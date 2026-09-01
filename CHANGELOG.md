# Changelog

All notable changes to ObniCode are documented in this file.

## [Unreleased]

## [2.0.0] - 2026-09-01

### Breaking Changes

- Removed startup background tasks and the `obnicode.backgroundTasks` setting.
- Removed YAML-based configuration references. ObniCode is configured exclusively through VS Code settings.

### Added

- Added an interactive release command that validates the changelog, builds the VSIX, creates a release commit, and adds a Git tag.


### Changed

- Rewrote the README in English to document the current configuration model and supported features.
