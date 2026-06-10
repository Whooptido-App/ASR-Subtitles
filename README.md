# Whooptido ASR Subtitles

Local speech recognition companion source for word-for-word subtitles in the [Whooptido](https://whooptido.app) browser extension.

## Purpose

This repository is a public, read-only source snapshot for the Whooptido ASR companion. It contains the runtime source used by the companion app to run verified hosted ASR model packages locally on a user's computer. Audio transcription happens locally; audio is not sent to a Whooptido server.

Development, build automation, signing, release packaging, and customer download hosting are handled outside this public repository.

## Downloads

Customer installers and update metadata are distributed through Whooptido-owned download infrastructure, not GitHub releases or raw GitHub file URLs from this repository.

Use the Whooptido extension settings or the official Whooptido website for supported installation paths.

## Requirements

- The [Whooptido Chrome Extension](https://whooptido.app)
- A supported companion build for your platform
- A verified hosted ASR model package installed from Whooptido Settings

## How It Works

1. The extension sends audio to the companion app through Chrome Native Messaging.
2. The companion app runs the installed hosted ASR model package locally.
3. Word-level timestamps are sent back to the extension.
4. The extension displays word-for-word subtitles in sync with the video.

## Building From Source

This public snapshot is provided for source visibility. Official signed builds are produced by Whooptido's private build and signing pipeline.

```bash
git clone https://github.com/Whooptido-App/ASR-Subtitles.git
cd ASR-Subtitles
npm install
node native-host.js
```

To create a local development binary:

```bash
npm install -g @yao-pkg/pkg
pkg native-host.js -t node20-macos-arm64
```

## Contributions

This repository is not a public contribution surface. Issues, pull requests, discussions, wiki, projects, releases, and Actions are disabled or restricted. Customer support and app issues belong in the private Whooptido app/reporting flow.

Security vulnerabilities must be reported privately. See [SECURITY.md](SECURITY.md).

## License

MIT
